import {updateActivity, type UpdateActivityGuard} from './activity.js';
export interface NativeOtaState {
  enabled: boolean; platform: 'ios'|'android'; runtime: string; channel: 'internal'|'production';
  connection: 'unknown'|'offline'|'wifi'|'cellular'; phase: string; received: number;
  current: string; installationId: string; cellularAllowed?: boolean; manifest?: string; total?: number; version?: string; releaseId?: string; error?: string;
}
export interface OtaNative {
  otaState(): Promise<NativeOtaState>;
  otaAccept(input:{manifest:string}): Promise<NativeOtaState>;
  otaDownload(input:{allowCellular:boolean}): Promise<NativeOtaState>;
  otaPause(): Promise<void>;
  otaActivate(): Promise<void>;
  otaReady(): Promise<void>;
}
export interface UpdateView { native: NativeOtaState|null; blocking: boolean; checking: boolean; downloading: boolean; error?: string }
const INITIAL: UpdateView={native:null,blocking:false,checking:false,downloading:false};
export interface UpdateEndpoints { checkUrl: string; eventsUrl?: string }
function pinnedHttps(value:string):string {
  const url=new URL(value);
  if(url.protocol!=='https:'||!url.hostname||url.username||url.password||url.hash||url.href!==value)throw Error('OTA_CONFIG');
  return value;
}

export class UpdateCoordinator {
  private readonly native: OtaNative;
  private readonly guard: UpdateActivityGuard;
  private readonly request: typeof fetch;
  private readonly config: UpdateEndpoints;
  private view:UpdateView={...INITIAL};
  private listeners=new Set<()=>void>();
  private checking:Promise<void>|null=null;
  private download:Promise<void>|null=null;
  private stopped=false;
  private active=true;
  private activating=false;
  private retries=0;
  private downloadBlocked=false;
  private pauseRequested=false;
  private nextDownloadAt=0;
  private lastDownloadAt=0;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private checkTimer:ReturnType<typeof setTimeout>|undefined;
  private checkFailures=0;
  private nextCheckAt=0;
  private unsubscribe:()=>void;
  private events=new Set<string>();
  constructor(native:OtaNative,config:UpdateEndpoints,guard:UpdateActivityGuard=updateActivity,request:typeof fetch=(...args)=>globalThis.fetch(...args)){
    this.native=native;this.guard=guard;this.request=request;
    this.config={checkUrl:pinnedHttps(config.checkUrl),eventsUrl:config.eventsUrl?pinnedHttps(config.eventsUrl):undefined};
    this.unsubscribe=guard.subscribe(()=>this.reconcile());
  }
  getSnapshot=()=>this.view;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private publish(patch:Partial<UpdateView>){if(this.stopped)return;this.view={...this.view,...patch};this.listeners.forEach(l=>l());}
  async start(){const state=await this.native.otaState();if(this.stopped)return;this.receive(state);if(state.enabled)this.scheduleCheck(Math.random()*3000);}
  private scheduleCheck(delay:number){
    clearTimeout(this.checkTimer);this.checkTimer=undefined;
    if(this.stopped||!this.active||this.view.native?.connection==='offline')return;
    this.checkTimer=setTimeout(()=>{this.checkTimer=undefined;void this.check();},Math.max(0,delay));
  }
  setActive(active:boolean){
    this.active=active;
    if(!active){clearTimeout(this.timer);this.timer=undefined;clearTimeout(this.checkTimer);this.checkTimer=undefined;}
    else{void this.native.otaState().then(state=>{this.receive(state);this.scheduleCheck(Math.max(0,this.nextCheckAt-Date.now()));}).catch(()=>{});}
    this.reconcile();
  }
  receive=(state:NativeOtaState)=>{
    if(this.stopped)return;
    const before=this.view.native;
    this.publish({native:state,error:state.error});
    if(before?.manifest && !state.manifest && state.current===before.current && before.phase==='installing')this.event('rollback',before);
    if(state.manifest && state.manifest!==before?.manifest){this.retries=0;this.downloadBlocked=false;this.nextDownloadAt=0;clearTimeout(this.timer);this.timer=undefined;this.event('available',state);}
    if(before && before.connection!==state.connection && state.connection!=='offline' && state.connection!=='unknown'){
      // Network flapping must not generate an unbounded immediate retry loop.
      if(!this.downloadBlocked){this.nextDownloadAt=Math.min(this.nextDownloadAt,Math.max(Date.now(),this.lastDownloadAt+3000)+Math.random()*1000);clearTimeout(this.timer);this.timer=undefined;}
      if(this.checkFailures||before.connection==='offline'||before.connection==='unknown')this.scheduleCheck(Math.max(0,this.nextCheckAt-Date.now()));
    }
    this.reconcile();
  };
  private reconcile(){
    if(this.stopped)return;
    const s=this.view.native;
    if(!s?.enabled||!s.manifest){clearTimeout(this.timer);this.timer=undefined;this.guard.unlock();if(this.view.blocking)this.publish({blocking:false});return;}
    if(this.guard.size||!this.active){
      if(this.download&&!this.pauseRequested){this.pauseRequested=true;void this.native.otaPause().catch(()=>{});}
      return;
    }
    if(!this.view.blocking && this.guard.lock())this.publish({blocking:true});
    if(!this.view.blocking || this.download || this.timer)return;
    if(s.phase==='ready'){void this.activate();return;}
    if(!this.downloadBlocked&&(s.connection==='wifi'||(s.connection==='cellular'&&s.cellularAllowed)) && ['required','idle','wifi','paused','error'].includes(s.phase)){
      const delay=this.nextDownloadAt-Date.now();
      if(delay>0)this.timer=setTimeout(()=>{this.timer=undefined;this.reconcile();},delay);
      else void this.beginDownload(false);
    }
  }
  async check(force=false){
    if(this.stopped||!this.active)return;
    if(this.checking)return this.checking;
    const s=this.view.native;if(!s?.enabled)return;
    if(s.connection==='offline'||s.connection==='unknown')return;
    if(!force&&Date.now()<this.nextCheckAt){this.scheduleCheck(this.nextCheckAt-Date.now());return;}
    clearTimeout(this.checkTimer);this.checkTimer=undefined;
    this.nextCheckAt=0;this.publish({checking:true});
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),5000);
    const task=(async()=>{
      try{
        const response=await this.request(this.config.checkUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({platform:s.platform,channel:s.channel,runtime:s.runtime}),signal:controller.signal,cache:'no-store',redirect:'error'});
        if(!response.ok){const seconds=Number(response.headers.get('retry-after'));if(Number.isFinite(seconds)&&seconds>0)this.nextCheckAt=Date.now()+Math.min(seconds,900)*1000;throw Error('OTA_NETWORK');}
        const reader=response.body?.getReader();if(!reader)throw Error('OTA_NETWORK');
        const parts:Uint8Array[]=[];let size=0;
        for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>32768){await reader.cancel();throw Error('OTA_INVALID');}parts.push(value);}
        const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
        const value=JSON.parse(new TextDecoder().decode(bytes));
        if(!value||typeof value!=='object'||(value.manifest!==null&&typeof value.manifest!=='string'))throw Error('OTA_INVALID');
        if(typeof value.manifest==='string')this.receive(await this.native.otaAccept({manifest:value.manifest}));
        // An absent response cannot revoke a previously verified mandatory update.
        this.checkFailures=0;this.nextCheckAt=Date.now()+15*60_000+Math.random()*60_000;
      }catch(error){
        if(this.view.native?.manifest)this.publish({error:this.view.error??'OTA_NETWORK'});
        this.checkFailures++;
        const delay=Math.min(15*60_000,5000*2**Math.min(this.checkFailures-1,8));
        this.nextCheckAt=Math.max(this.nextCheckAt,Date.now()+delay+Math.random()*delay*0.2);
      }finally{clearTimeout(timeout);this.checking=null;this.publish({checking:false});this.scheduleCheck(this.nextCheckAt-Date.now());}
    })();this.checking=task;return task;
  }
  async retry(allowCellular=false){
    clearTimeout(this.timer);this.timer=undefined;this.retries=0;this.downloadBlocked=false;this.nextDownloadAt=0;
    await this.check(true);if(!this.view.native?.manifest)return;
    await this.beginDownload(allowCellular);
  }
  private beginDownload(allowCellular:boolean):Promise<void>{
    if(this.download)return this.download;
    if(this.stopped||!this.active||!this.view.blocking||this.guard.size)return Promise.resolve();
    const connection=this.view.native?.connection;
    if(connection==='offline'||connection==='unknown')return Promise.resolve();
    this.pauseRequested=false;this.lastDownloadAt=Date.now();
    this.publish({downloading:true,error:undefined});this.event('download_started');
    // Assign before crossing the bridge: native state events can arrive before the promise resolves.
    const accepted=this.view.native?.manifest;
    const task=Promise.resolve().then(()=>this.native.otaDownload({allowCellular})).then(s=>{if(this.view.native?.manifest!==accepted)return;this.receive(s);this.event('download_complete',s);},error=>{
      if(this.stopped||this.view.native?.manifest!==accepted)return;
      const code=typeof error?.message==='string'&&/^OTA_[A-Z_]+$/.test(error.message)?error.message:'OTA_NETWORK';
      this.publish({error:code});this.event(code==='OTA_INVALID'?'verification_failed':code==='OTA_PAUSED'?'download_paused':'download_failed');
      if(code==='OTA_NETWORK'||code==='OTA_PAUSED'||code==='OTA_BUSY'){
        if(code==='OTA_NETWORK')this.retries++;
        // Two quick retries, then visible recovery with slower capped retries.
        // Keep partial bytes and never automatically bypass verification/storage errors.
        const base=code!=='OTA_NETWORK'?3000:this.retries===1?2000:this.retries===2?5000:Math.min(300_000,30_000*2**Math.min(this.retries-3,4));
        this.nextDownloadAt=Date.now()+base+Math.random()*Math.max(1000,base*0.2);
      }else this.downloadBlocked=true;
    }).finally(()=>{this.download=null;this.pauseRequested=false;this.publish({downloading:false});this.reconcile();});
    this.download=task;return task;
  }
  private async activate(){
    if(this.activating||this.stopped||!this.active||this.view.native?.phase!=='ready'||!this.view.blocking||this.guard.size)return;
    this.activating=true;
    this.publish({native:{...this.view.native,phase:'installing'},error:undefined});this.event('activation_started');
    try{await this.native.otaActivate();}catch{this.publish({error:'OTA_INVALID',native:this.view.native?{...this.view.native,phase:'error'}:null});}finally{this.activating=false;}
  }
  reportReady(state:NativeOtaState){if(state.manifest&&state.current!=='builtin')this.event('ready',state);}
  private event(event:string,state=this.view.native){
    if(!this.config.eventsUrl||!state?.releaseId)return;const key=state.releaseId+':'+event;if(this.events.has(key))return;
    this.events.add(key);if(this.events.size>100)this.events.delete(this.events.values().next().value!);
    // Success sampling, errors retained; metrics are best effort and never delay transactions.
    if(['available','download_started','download_complete','activation_started','ready'].includes(event)&&Math.random()>0.01)return;
    void this.request(this.config.eventsUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({releaseId:state.releaseId,installationId:state.installationId,event}),signal:AbortSignal.timeout(5000),cache:'no-store',redirect:'error'}).catch(()=>{});
  }
  stop(){this.stopped=true;clearTimeout(this.timer);clearTimeout(this.checkTimer);this.unsubscribe();this.guard.unlock();this.listeners.clear();void this.native.otaPause().catch(()=>{});}
}
