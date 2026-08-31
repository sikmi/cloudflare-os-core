import { WorkerEntrypoint } from "cloudflare:workers";

/**
 * RPC-compatible facade that exposes Workers AI to dynamically loaded Gadget workers.
 *
 * WorkerLoader environments can contain service bindings, but cannot contain a raw Workers AI
 * binding. Keeping this facade to `run()` also avoids exposing unrelated account-level APIs.
 */
export class GadgetAiBinding extends WorkerEntrypoint<Cloudflare.Env> {
  /** Runs a model using the Workshop deployment's Workers AI binding. */
  run(model: string, inputs: unknown, options?: unknown): Promise<unknown> {
    return Reflect.apply(
        this.env.WORKERS_AI.run, this.env.WORKERS_AI, [model, inputs, options]) as Promise<unknown>;
  }
}
