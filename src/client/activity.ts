export class UpdateActivityGuard {
  private active = new Set<symbol>();
  private listeners = new Set<() => void>();
  private locked = false;
  get size() { return this.active.size; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit() { this.listeners.forEach(listener => listener()); }
  begin(): () => void {
    if (this.locked) throw new Error('OTA_REQUIRED');
    const id = Symbol(); this.active.add(id); this.emit();
    return () => { if (this.active.delete(id)) this.emit(); };
  }
  lock(): boolean { if (this.active.size) return false; this.locked = true; return true; }
  unlock() { this.locked = false; }
  async run<T>(action: () => Promise<T>): Promise<T> { const finish=this.begin(); try { return await action(); } finally { finish(); } }
}
export const updateActivity = new UpdateActivityGuard();
