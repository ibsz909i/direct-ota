import {Capacitor, registerPlugin, type PluginListenerHandle} from '@capacitor/core';
import {App} from '@capacitor/app';
import {UpdateCoordinator, type NativeOtaState, type OtaNative, type UpdateEndpoints} from './coordinator.js';
import {UpdateActivityGuard, updateActivity} from './activity.js';
import {installUpdateDomGuard} from './dom-guard.js';

interface Bridge extends OtaNative {
  addListener(event:'otaStateChange', listener:(state:NativeOtaState)=>void):Promise<PluginListenerHandle>;
}
const bridge=registerPlugin<Bridge>('CapacitorUpdater');
export interface UpdaterOptions extends UpdateEndpoints {
  guard?: UpdateActivityGuard;
  protectDom?: boolean;
  onView?: (view:ReturnType<UpdateCoordinator['getSnapshot']>)=>void;
}
export interface UpdaterHandle {
  coordinator: UpdateCoordinator;
  guard: UpdateActivityGuard;
  markReady(): Promise<void>;
  stop(): void;
  routeChanged(): void;
}

/** Attach the Capacitor bridge. Call markReady only after the local route shell has committed. */
export async function startUpdater(options:UpdaterOptions):Promise<UpdaterHandle> {
  if(!Capacitor.isNativePlatform()||!Capacitor.isPluginAvailable('CapacitorUpdater'))throw Error('OTA_NATIVE_REQUIRED');
  const initial=await bridge.otaState();
  if(!initial.enabled)throw Error('OTA_CONFIG');
  const guard=options.guard??updateActivity;
  const coordinator=new UpdateCoordinator(bridge,{checkUrl:options.checkUrl,eventsUrl:options.eventsUrl},guard);
  const dom=options.protectDom===false?undefined:installUpdateDomGuard(document,guard);
  const unsubscribe=options.onView?coordinator.subscribe(()=>options.onView?.(coordinator.getSnapshot())):()=>{};
  options.onView?.(coordinator.getSnapshot());
  const listeners=[bridge.addListener('otaStateChange',coordinator.receive),
    App.addListener('appStateChange',({isActive})=>coordinator.setActive(isActive))];
  let stopped=false;
  let ready:Promise<void>|undefined;
  const markReady=()=>{
    if(stopped)return Promise.reject(Error('OTA_STOPPED'));
    if(ready)return ready;
    ready=new Promise<void>((resolve,reject)=>{
      requestAnimationFrame(()=>requestAnimationFrame(()=>{
        try {
          if(stopped)throw Error('OTA_STOPPED');
          const probe='direct-ota:storage-probe';
          localStorage.setItem(probe,'1');localStorage.removeItem(probe);
          void bridge.otaState().then(async before=>{
            if(stopped)throw Error('OTA_STOPPED');
            await bridge.otaReady();
            coordinator.reportReady(before);
            await coordinator.start();
            resolve();
          }).catch(reject);
        } catch(error) { reject(error); }
      }));
    });
    return ready;
  };
  return {coordinator,guard,markReady,routeChanged:()=>dom?.routeChanged(),stop(){
    if(stopped)return;stopped=true;unsubscribe();dom?.dispose();coordinator.stop();
    listeners.forEach(p=>void p.then(h=>h.remove()).catch(()=>{}));
  }};
}

export function markReady(handle:UpdaterHandle):Promise<void> { return handle.markReady(); }
export {UpdateCoordinator, UpdateActivityGuard, updateActivity, installUpdateDomGuard};
export type {NativeOtaState, OtaNative, UpdateEndpoints} from './coordinator.js';
export type {UpdateView} from './coordinator.js';
export {mountUpdateUi} from './ui.js';
export type {UpdateUiStrings, UpdateUiOptions} from './ui.js';
