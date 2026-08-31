import { describe, expect, it, vi } from "vitest";
import { GadgetAiBinding } from "../src/gadget-ai-binding.js";

describe("GadgetAiBinding", () => {
  it("forwards run calls to the deployment Workers AI binding", async () => {
    let result = { text: "transcribed" };
    let run = vi.fn(async () => result);
    let binding = new GadgetAiBinding(
        {} as ExecutionContext,
        { WORKERS_AI: { run } } as unknown as Cloudflare.Env);
    let inputs = { audio: [1, 2, 3] };
    let options = { prefix: "test" };

    await expect(binding.run("@cf/openai/whisper-large-v3-turbo", inputs, options))
      .resolves.toEqual(result);
    expect(run).toHaveBeenCalledWith(
        "@cf/openai/whisper-large-v3-turbo", inputs, options);
  });
});
