import type {UpdateCoordinator, UpdateView} from './coordinator.js';

export interface UpdateUiStrings {
  title:string; offline:string; verifying:string; installing:string; downloading:string;
  cellular:string; wifi:string; storageError:string; verificationError:string;
  interrupted:string; retry:string; useCellular:string; keepOpen:string;
  progress:string; downloaded:(receivedKiB:number,totalKiB:number,percent:number)=>string;
}
export interface UpdateUiOptions {
  coordinator:UpdateCoordinator; appRoot:HTMLElement; strings:UpdateUiStrings;
  direction?:'ltr'|'rtl'; document?:Document;
}

/** Optional framework-neutral blocking view. All visible copy comes from the host app. */
export function mountUpdateUi(options:UpdateUiOptions):()=>void {
  const doc=options.document??document;
  let dialog:HTMLElement|undefined,previousFocus:Element|null=null,previousInert=false,previousOverflow='';
  const element=(tag:string,text?:string)=>{const node=doc.createElement(tag);if(text)node.textContent=text;return node;};
  const close=()=>{
    if(!dialog)return;
    dialog.remove();dialog=undefined;options.appRoot.inert=previousInert;doc.body.style.overflow=previousOverflow;
    if(previousFocus instanceof HTMLElement)previousFocus.focus();
  };
  const render=()=>{
    const view:UpdateView=options.coordinator.getSnapshot();
    if(!view.blocking||!view.native){close();return;}
    const s=view.native,strings=options.strings;
    if(!dialog){
      previousFocus=doc.activeElement;previousInert=options.appRoot.inert;previousOverflow=doc.body.style.overflow;
      options.appRoot.inert=true;doc.body.style.overflow='hidden';
      dialog=element('div');dialog.dataset.otaDialog='';dialog.dir=options.direction??'ltr';
      Object.assign(dialog.style,{position:'fixed',inset:'0',zIndex:'2147483647',display:'grid',placeItems:'center',padding:'16px',background:'rgba(0,0,0,.55)'});
      doc.body.append(dialog);
    }
    dialog.replaceChildren();
    const panel=element('section');panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.tabIndex=-1;
    Object.assign(panel.style,{boxSizing:'border-box',width:'min(100%,420px)',padding:'24px',borderRadius:'20px',background:'#fff',color:'#172033',fontFamily:'system-ui,sans-serif',boxShadow:'0 16px 48px rgba(0,0,0,.2)'});
    const title=element('h2',strings.title);title.id='direct-ota-title';panel.setAttribute('aria-labelledby',title.id);
    const offline=s.connection==='offline'||s.connection==='unknown';
    const cellular=s.connection==='cellular'&&!s.cellularAllowed;
    const busy=view.downloading||['verifying','installing'].includes(s.phase);
    const message=view.error==='OTA_STORAGE'?strings.storageError:view.error==='OTA_INVALID'?strings.verificationError:
      offline?strings.offline:s.phase==='verifying'?strings.verifying:s.phase==='installing'?strings.installing:
      view.downloading?strings.downloading:cellular?strings.cellular:view.error?strings.interrupted:strings.wifi;
    const body=element('p',message);body.id='direct-ota-body';body.setAttribute('aria-live','polite');panel.setAttribute('aria-describedby',body.id);
    const percent=s.total?Math.min(100,Math.max(0,Math.floor(s.received/s.total*1000)/10)):0;
    const progress=element('progress') as HTMLProgressElement;progress.max=100;progress.value=percent;progress.style.width='100%';progress.setAttribute('aria-label',strings.progress);
    const caption=element('p',strings.downloaded(Math.ceil(s.received/1024),Math.ceil((s.total??0)/1024),percent));
    panel.append(title,body,progress,caption);
    if(!busy){const retry=element('button',cellular?strings.useCellular:strings.retry) as HTMLButtonElement;
      retry.type='button';retry.style.cssText='min-height:44px;width:100%;font:inherit;cursor:pointer';
      retry.addEventListener('click',()=>void options.coordinator.retry(cellular));panel.append(retry);}
    panel.append(element('p',strings.keepOpen));
    panel.addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();}
      if(event.key==='Tab'){const button=panel.querySelector('button');if(button){event.preventDefault();(button as HTMLElement).focus();}else event.preventDefault();}
    });
    dialog.append(panel);panel.focus();
  };
  const unsubscribe=options.coordinator.subscribe(render);render();
  return ()=>{unsubscribe();close();};
}
