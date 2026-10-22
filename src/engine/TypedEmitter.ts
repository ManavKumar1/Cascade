import { EventEmitter } from "node:events";

type ListenerSignature<L> = {
  [K in keyof L]: (...args: any[]) => void;
};

/** A thin, typed facade over EventEmitter so listeners get real parameter types. */
export class TypedEmitter<Events extends ListenerSignature<Events>> {
  private emitter = new EventEmitter();

  on<K extends keyof Events & string>(event: K, listener: Events[K]): void {
    this.emitter.on(event, listener);
  }

  off<K extends keyof Events & string>(event: K, listener: Events[K]): void {
    this.emitter.off(event, listener);
  }

  emit<K extends keyof Events & string>(event: K, ...args: Parameters<Events[K]>): void {
    this.emitter.emit(event, ...args);
  }
}
