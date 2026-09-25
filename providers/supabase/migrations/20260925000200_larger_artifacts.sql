-- Widen only the isolated OTA bucket and its server-side hard ceiling.
-- The signed public trust and native binary still pin each app's lower limit.
 DO $$ BEGIN
   IF (SELECT file_size_limit FROM storage.buckets WHERE id='direct-ota') IS DISTINCT FROM 5242880 THEN
     RAISE EXCEPTION 'Unexpected Direct OTA bucket limit';
   END IF;
 END $$;
 UPDATE storage.buckets SET file_size_limit=52428800 WHERE id='direct-ota';

CREATE OR REPLACE FUNCTION public.direct_ota_command(
 p_key_id text,p_nonce uuid,p_expires_at timestamptz,p_action text,
 p_manifest text DEFAULT NULL,p_payload jsonb DEFAULT NULL,p_selector jsonb DEFAULT NULL,
 p_expected_sequence bigint DEFAULT NULL,p_verified_sha256 text DEFAULT NULL,p_verified_bytes bigint DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='5s' SET lock_timeout='1s' AS $$
DECLARE
 c direct_ota_private.configuration%ROWTYPE; r direct_ota_private.releases%ROWTYPE;
 v_platform text; v_channel text; v_runtime text; v_id uuid; v_sequence bigint; v_path text; v_artifact jsonb;
 v_head bigint; v_current text; v_uploaded boolean=false; v_count bigint; v_used bigint;
 v_minute timestamptz=date_trunc('minute',now());
BEGIN
 SELECT * INTO c FROM direct_ota_private.configuration WHERE singleton FOR UPDATE;
 IF NOT FOUND OR NOT c.enabled OR c.key_id IS DISTINCT FROM p_key_id OR p_nonce IS NULL OR p_expires_at IS NULL OR p_expires_at<=now() OR p_expires_at>now()+interval '65 seconds' THEN RAISE EXCEPTION 'Publisher denied' USING ERRCODE='42501'; END IF;
 IF c.window_start=v_minute AND c.window_count>=60 THEN RAISE EXCEPTION 'Publisher rate limit' USING ERRCODE='54000'; END IF;
 UPDATE direct_ota_private.configuration SET window_start=v_minute,window_count=CASE WHEN window_start=v_minute THEN window_count+1 ELSE 1 END WHERE singleton;
 DELETE FROM direct_ota_private.nonces WHERE nonce IN (SELECT nonce FROM direct_ota_private.nonces WHERE expires_at<now()-interval '1 hour' ORDER BY expires_at LIMIT 1000);
 INSERT INTO direct_ota_private.nonces VALUES(p_nonce,p_expires_at);
 IF p_action IS NULL OR p_action NOT IN ('status','reserve','promote') THEN RAISE EXCEPTION 'Invalid action' USING ERRCODE='23514'; END IF;
 IF p_action='status' THEN
  v_platform=p_selector->>'platform'; v_channel=p_selector->>'channel'; v_runtime=p_selector->>'runtime';
  IF v_platform IS NULL OR v_platform NOT IN ('ios','android') OR v_channel IS NULL OR v_channel NOT IN ('internal','production') OR v_runtime IS NULL OR v_runtime!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid selector' USING ERRCODE='23514'; END IF;
  SELECT h.sequence,rr.manifest INTO v_head,v_current FROM direct_ota_private.heads h JOIN direct_ota_private.releases rr USING(release_id) WHERE h.platform=v_platform AND h.channel=v_channel AND h.runtime=v_runtime;
  RETURN jsonb_build_object('sequence',coalesce(v_head,0),'manifest',v_current);
 END IF;
 IF p_payload IS NULL OR p_payload->>'protocol' IS DISTINCT FROM '1' OR p_payload->>'appId' IS DISTINCT FROM c.app_id OR p_payload->>'environment' IS DISTINCT FROM c.environment OR p_payload->>'backendContract' IS DISTINCT FROM c.backend_contract::text OR p_payload->>'action' IS NULL OR p_payload->>'action' NOT IN ('release','withdraw') OR p_manifest IS NULL THEN RAISE EXCEPTION 'Invalid metadata' USING ERRCODE='23514'; END IF;
 v_id=(p_payload->>'releaseId')::uuid; v_sequence=(p_payload->>'sequence')::bigint;
 v_platform=p_payload->>'platform'; v_channel=p_payload->>'channel'; v_runtime=p_payload->>'runtime';
 v_artifact=p_payload->'artifact'; v_path=v_artifact->>'path';
 IF p_payload->>'action'='release' THEN
  IF jsonb_typeof(v_artifact) IS DISTINCT FROM 'object' OR v_path IS NULL OR v_path !~ ('^'||v_platform||'/'||v_runtime||'/[0-9a-f-]{36}/[0-9a-f]{64}\.zip$') OR v_artifact->>'url' IS DISTINCT FROM c.artifact_base_url||'/'||v_path OR (v_artifact->>'bytes')::bigint NOT BETWEEN 1 AND 52428800 THEN RAISE EXCEPTION 'Invalid artifact' USING ERRCODE='23514'; END IF;
  SELECT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='direct-ota' AND name=v_path AND (metadata->>'size')::numeric=(v_artifact->>'bytes')::bigint) INTO v_uploaded;
 ELSE
  IF v_artifact IS NOT NULL OR p_action='reserve' THEN RAISE EXCEPTION 'Invalid withdrawal' USING ERRCODE='23514'; END IF;
 END IF;
 SELECT * INTO r FROM direct_ota_private.releases WHERE release_id=v_id;
 IF FOUND AND (r.manifest<>p_manifest OR r.payload<>p_payload) THEN RAISE EXCEPTION 'Immutable release conflict' USING ERRCODE='23505'; END IF;
 IF p_action='reserve' THEN
  IF r.release_id IS NULL THEN
   IF split_part(v_path,'/',3)<>v_id::text AND (NOT v_uploaded OR NOT EXISTS(SELECT 1 FROM direct_ota_private.releases old WHERE old.promoted_at IS NOT NULL AND old.platform=v_platform AND old.runtime=v_runtime AND old.payload->'artifact'=v_artifact)) THEN RAISE EXCEPTION 'Unknown rollback artifact' USING ERRCODE='23514'; END IF;
  ELSE
   UPDATE direct_ota_private.releases SET expires_at=now()+interval '2 hours' WHERE release_id=v_id;
   RETURN jsonb_build_object('releaseId',v_id,'path',v_path,'uploadRequired',NOT v_uploaded);
  END IF;
 ELSE
  IF p_expected_sequence IS NULL OR p_expected_sequence<0 OR v_sequence<>p_expected_sequence+1 THEN RAISE EXCEPTION 'Invalid sequence' USING ERRCODE='23514'; END IF;
  SELECT h.sequence,rr.manifest INTO v_head,v_current FROM direct_ota_private.heads h JOIN direct_ota_private.releases rr USING(release_id) WHERE h.platform=v_platform AND h.channel=v_channel AND h.runtime=v_runtime;
  IF v_current=p_manifest THEN RETURN jsonb_build_object('releaseId',v_id,'sequence',v_sequence); END IF;
  IF coalesce(v_head,0)<>p_expected_sequence OR r.promoted_at IS NOT NULL THEN RAISE EXCEPTION 'Sequence conflict' USING ERRCODE='40001'; END IF;
  IF p_payload->>'action'='release' AND (r.release_id IS NULL OR r.expires_at<=now() OR NOT v_uploaded OR p_verified_sha256 IS DISTINCT FROM v_artifact->>'sha256' OR p_verified_bytes IS DISTINCT FROM (v_artifact->>'bytes')::bigint) THEN RAISE EXCEPTION 'Verified reserved artifact required' USING ERRCODE='23514'; END IF;
  IF v_head IS NULL AND (SELECT count(*) FROM direct_ota_private.heads)>=256 THEN RAISE EXCEPTION 'Channel capacity' USING ERRCODE='54000'; END IF;
 END IF;
 IF r.release_id IS NULL THEN
  SELECT count(*) INTO v_count FROM direct_ota_private.releases;
  IF v_count>=10000 THEN RAISE EXCEPTION 'Release capacity' USING ERRCODE='54000'; END IF;
  IF v_path IS NOT NULL AND NOT EXISTS(SELECT 1 FROM direct_ota_private.releases WHERE payload->'artifact'->>'path'=v_path) THEN
   SELECT coalesce(sum(t.bytes),0) INTO v_used FROM (SELECT payload->'artifact'->>'path',max((payload->'artifact'->>'bytes')::bigint) bytes FROM direct_ota_private.releases WHERE payload ? 'artifact' GROUP BY 1) t;
   IF v_used+(v_artifact->>'bytes')::bigint>2147483648 THEN RAISE EXCEPTION 'Storage capacity' USING ERRCODE='54000'; END IF;
  END IF;
  INSERT INTO direct_ota_private.releases(release_id,platform,channel,runtime,sequence,manifest,payload) VALUES(v_id,v_platform,v_channel,v_runtime,v_sequence,p_manifest,p_payload);
 END IF;
 IF p_action='reserve' THEN
  INSERT INTO direct_ota_private.audit(operation,release_id,sequence) VALUES('reserve',v_id,v_sequence);
  RETURN jsonb_build_object('releaseId',v_id,'path',v_path,'uploadRequired',NOT v_uploaded);
 END IF;
 UPDATE direct_ota_private.releases SET promoted_at=now() WHERE release_id=v_id;
 INSERT INTO direct_ota_private.heads VALUES(v_platform,v_channel,v_runtime,v_sequence,v_id) ON CONFLICT(platform,channel,runtime) DO UPDATE SET sequence=excluded.sequence,release_id=excluded.release_id;
 INSERT INTO direct_ota_private.audit(operation,release_id,sequence) VALUES(p_payload->>'action',v_id,v_sequence);
 RETURN jsonb_build_object('releaseId',v_id,'sequence',v_sequence);
END $$;
