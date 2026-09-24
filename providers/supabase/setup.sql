-- Replace these PUBLIC values from direct-ota.config.json. Never paste private keys.
-- Run once as the database owner after the migration; deployment starts disabled.
INSERT INTO direct_ota_private.configuration(key_id,app_id,environment,artifact_base_url,backend_contract,enabled)
VALUES('REPLACE_WITH_KEY_ID','app.example.demo','production','https://YOUR_PROJECT.supabase.co/storage/v1/object/public/direct-ota',1,true);
-- Emergency server-side publishing stop (does not revoke keys already on phones):
-- UPDATE direct_ota_private.configuration SET enabled=false WHERE singleton=true;
