import {updateActivity, type UpdateActivityGuard} from './activity.js';
/** Conservative protection for open sheets and edited forms, without reading input contents. */
export function installUpdateDomGuard(root:Document=document,guard:UpdateActivityGuard=updateActivity){
  const dirty=new Set<Element>();let release:(()=>void)|undefined;let frame=0;
  const scan=()=>{
    frame=0;
    for(const node of dirty)if(!node.isConnected)dirty.delete(node);
    const modal=Array.from(root.querySelectorAll('dialog[open],[role="dialog"][aria-modal="true"]')).some(node=>!node.closest('[data-ota-dialog]'));
    if((modal||dirty.size)&&!release){try{release=guard.begin();}catch{/* New background interaction is prevented by the blocking dialog. */}}
    if(!modal&&!dirty.size&&release){const done=release;release=undefined;done();}
  };
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(scan);};
  const edit=(event:Event)=>{const target=event.target;if(!(target instanceof Element)||target.closest('[data-ota-dialog]'))return;dirty.add(target.closest('form,dialog,[role="dialog"]')??target);scan();};
  const observer=new MutationObserver(schedule);observer.observe(root.body,{childList:true,subtree:true,attributes:true,attributeFilter:['open','aria-modal']});
  root.addEventListener('input',edit,true);root.addEventListener('change',edit,true);scan();
  return {routeChanged(){dirty.clear();scan();},dispose(){observer.disconnect();cancelAnimationFrame(frame);root.removeEventListener('input',edit,true);root.removeEventListener('change',edit,true);release?.();}};
}
