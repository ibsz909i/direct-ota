import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createOtaServer} from 'direct-ota/server';
const trust = JSON.parse(await readFile(process.env.OTA_TRUST_FILE || './direct-ota.config.json','utf8'));
const dataDir=process.env.OTA_DATA_DIR || join(homedir(),'.local','state','direct-ota',trust.appId,trust.environment);
const server = await createOtaServer({trust,dataDir,publisherEnabled:process.env.OTA_PUBLISHER_ENABLED !== 'false'});
server.listen(Number(process.env.PORT || 8787),process.env.HOST || '127.0.0.1',()=>console.log('Direct OTA service listening behind your HTTPS proxy'));
for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>server.close());
