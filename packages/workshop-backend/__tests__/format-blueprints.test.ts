import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  buildBlueprintArchiveStream, parseBlueprintArchive, parseBlueprintKvRecord,
  sanitizeBlueprintOutput, serializeFeaturedBlueprints,
} from "../src/blueprint-archive.js";
import { formatBlueprintsManifestVersion, installFormatBlueprints } from "../src/format-blueprints.js";
import { FORMAT_BLUEPRINTS } from "../src/generated/format-blueprints.js";

async function readBlueprintFile(
  entry: (typeof FORMAT_BLUEPRINTS)[number],
  filename: string,
): Promise<string> {
  let archive = new Response(Uint8Array.fromBase64(entry.archive) as BufferSource).body!;
  let {content} = await parseBlueprintArchive(archive);
  let decompressed = content.pipeThrough(new DecompressionStream("gzip"));
  let update = new Uint8Array(await new Response(decompressed).arrayBuffer());
  let doc = new Y.Doc();
  Y.applyUpdateV2(doc, update);
  return doc.getMap<Y.Text>().get(filename)?.toString() ?? "";
}

// Minimal in-memory stand-ins for the two bindings the installer writes to. They record what was
// written so the test can assert on the installed blueprint the way a reader would see it.
function makeEnv() {
  let kv = new Map<string, string>();
  let r2 = new Map<string, Uint8Array>();
  return {
    kv,
    r2,
    env: {
      BLUEPRINTS: {
        put: async (key: string, value: string) => { kv.set(key, value); },
      },
      BLUEPRINT_CONTENT: {
        // Deliberately strict: real R2 rejects a stream of unknown length, so accepting one here
        // would hide exactly the bug this stands in for.
        put: async (key: string, value: unknown) => {
          if (!ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer)) {
            throw new TypeError(
                "Provided readable stream must have a known length " +
                "(request/response body or readable half of FixedLengthStream)");
          }
          r2.set(key, new Uint8Array(ArrayBuffer.isView(value)
              ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
              : value));
        },
      },
    } as unknown as Pick<Cloudflare.Env, "BLUEPRINTS" | "BLUEPRINT_CONTENT">,
  };
}

describe("blueprint metadata boundary", () => {
  const privateSentinel = "private-value-must-not-be-shared";

  function boundaryRecord() {
    return {
      metadata: {
        title: "People viewer",
        description: "A table",
        author: {type: "user", id: "author", name: "Author", token: privateSentinel},
        created: new Date(0),
        version: 1,
        lastUpdated: new Date(0),
        output: {
          id: "table",
          noun: "Table",
          plural: "Tables",
          icon: "table",
          privateState: privateSentinel,
        },
        bindings: {
          PEOPLE: {
            title: "People",
            description: "Directory",
            type: "gatekeeper",
            gatekeeperName: "sikmi-corp",
            typeUrlPattern: "https://corp.example/people/*",
            resourceUrl: "https://corp.example/people/directory",
            included: false,
            token: privateSentinel,
          },
          MODEL: {
            title: "Model",
            description: "Assistant model",
            type: "aiModel",
            suggestedModel: {
              provider: "workers-ai",
              modelName: "model",
              token: privateSentinel,
            },
          },
          SPAWNER: {
            title: "Spawner",
            description: "Starts an agent",
            type: "agentSpawner",
            suggestedModel: {
              provider: "workers-ai",
              modelName: "model",
              privateState: privateSentinel,
            },
            env: {
              PEOPLE: {type: "binding", name: "PEOPLE", token: privateSentinel},
              GADGET: {type: "gadget", privateState: privateSentinel},
            },
          },
        },
        privateState: privateSentinel,
      },
      ownerId: "owner",
      gadgetId: "gadget",
      token: privateSentinel,
    };
  }

  it("deeply copies only the shared metadata allowlist", () => {
    let record = parseBlueprintKvRecord(JSON.stringify(boundaryRecord()));

    expect(record).toEqual({
      metadata: {
        title: "People viewer",
        description: "A table",
        author: {type: "user", id: "author", name: "Author"},
        created: new Date(0),
        version: 1,
        lastUpdated: new Date(0),
        output: {id: "table", noun: "Table", plural: "Tables", icon: "table"},
        bindings: {
          PEOPLE: {
            title: "People",
            description: "Directory",
            type: "gatekeeper",
            gatekeeperName: "sikmi-corp",
            typeUrlPattern: "https://corp.example/people/*",
            resourceUrl: "https://corp.example/people/directory",
          },
          MODEL: {
            title: "Model",
            description: "Assistant model",
            type: "aiModel",
            suggestedModel: {provider: "workers-ai", modelName: "model"},
          },
          SPAWNER: {
            title: "Spawner",
            description: "Starts an agent",
            type: "agentSpawner",
            suggestedModel: {provider: "workers-ai", modelName: "model"},
            env: {
              PEOPLE: {type: "binding", name: "PEOPLE"},
              GADGET: {type: "gadget"},
            },
          },
        },
      },
      ownerId: "owner",
      gadgetId: "gadget",
    });
    expect(JSON.stringify(record)).not.toContain(privateSentinel);
    expect(JSON.stringify(record)).not.toContain('"included"');

    let featured = serializeFeaturedBlueprints([{
      id: "people-viewer",
      metadata: boundaryRecord().metadata as never,
    }]);
    expect(featured).not.toContain(privateSentinel);
    expect(featured).not.toContain('"included"');
  });

  it("removes private nested fields before encoding a download archive", async () => {
    let rawMetadata = boundaryRecord().metadata;
    let archive = buildBlueprintArchiveStream(
      rawMetadata as never,
      new Response(new Uint8Array()).body!,
      0,
    );
    let bytes = new Uint8Array(await new Response(archive).arrayBuffer());
    let metadataLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(12);
    let encodedMetadata = new TextDecoder().decode(bytes.subarray(24, 24 + metadataLength));

    expect(encodedMetadata).not.toContain(privateSentinel);
    expect(encodedMetadata).not.toContain('"included"');
    expect(JSON.parse(encodedMetadata)).toEqual(
      JSON.parse(JSON.stringify(parseBlueprintKvRecord(JSON.stringify(boundaryRecord())).metadata))
    );
  });

  it("rejects missing fields and invalid union discriminators", () => {
    let record = boundaryRecord();
    expect(() => parseBlueprintKvRecord(JSON.stringify({
      ...record,
      metadata: {...record.metadata, author: {id: "author", name: "Author"}},
    }))).toThrow("Blueprint metadata.author.type is invalid.");

    expect(() => parseBlueprintKvRecord(JSON.stringify({
      ...record,
      metadata: {
        ...record.metadata,
        bindings: {
          INVALID: {title: "Invalid", description: "", type: "http"},
        },
      },
    }))).toThrow("Blueprint metadata.bindings.INVALID.type is invalid.");
  });
});

describe("bundled format blueprints", () => {
  it("installs every manifest entry as an ordinary blueprint", async () => {
    let {kv, r2, env} = makeEnv();

    let installed = await installFormatBlueprints(env);

    expect(installed).toHaveLength(FORMAT_BLUEPRINTS.length);
    for (let entry of FORMAT_BLUEPRINTS) {
      let raw = kv.get(entry.blueprintId);
      expect(raw, `${entry.blueprintId} metadata`).toBeDefined();

      let record = parseBlueprintKvRecord(raw!);
      // No owning user: these belong to the deployment, so the owner-anchored featured toggle
      // must not apply to them.
      expect(record.ownerId).toBeUndefined();
      // Presentation comes from the sidecar, not from whatever the archive was called in the
      // workspace it was exported from.
      expect(record.metadata.title).toBe(entry.title);
      expect(record.metadata.description).toBe(entry.description);
      expect(record.metadata.author).toEqual(entry.author);
      // The sidecar's declaration is written into the installed blueprint, so from here on the
      // blueprint declares its own format like any other.
      expect(record.metadata.output).toEqual(entry.output);
      // ...and it survives the same validation an uploaded archive's would.
      expect(sanitizeBlueprintOutput(record.metadata.output)).toEqual(entry.output);

      // Content lands where readBlueprintContent() looks for it.
      let content = r2.get(`${entry.blueprintId}/${record.metadata.version}`);
      expect(content, `${entry.blueprintId} content`).toBeDefined();
      expect(content!.byteLength).toBeGreaterThan(0);
    }
  });

  it("ships print layouts for every standard output format", async () => {
    for (let entry of FORMAT_BLUEPRINTS) {
      expect(await readBlueprintFile(entry, "client.js"), entry.blueprintId)
        .toContain("@media print");
    }
  });

  it("renders document HTML and PDF exports without the editor chrome", async () => {
    let entry = FORMAT_BLUEPRINTS.find(blueprint => blueprint.blueprintId === "format.document")!;
    let client = await readBlueprintFile(entry, "client.js");

    expect(client).toContain('["html", "pdf"].includes(globalThis.gadgetExportFormatId)');
    expect(client).toContain('document.documentElement.classList.add("document-export")');
    expect(client).toContain("app.replaceChildren(canvas)");
  });

  it("declares the intended export formats for every standard output format", async () => {
    let expectedFormats: Record<string, string[]> = {
      "format.document": [
        'id: "markdown", label: "Markdown", mode: "server", contentType: "text/markdown"',
        'id: "html", label: "HTML", mode: "browser", contentType: "text/html"',
        'id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf"',
      ],
      "format.slides": [
        'id: "html", label: "HTML", mode: "browser", contentType: "text/html"',
        'id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf"',
      ],
      "format.spreadsheet": [
        'const CSV_FORMAT_PREFIX = "csv:"',
        'mode: "server"',
        'contentType: "text/csv"',
      ],
    };

    for (let entry of FORMAT_BLUEPRINTS) {
      let serverCode = await readBlueprintFile(entry, "server.js");
      expect(serverCode, entry.blueprintId).toContain("export class ExportHandler");
      for (let declaration of expectedFormats[entry.blueprintId] ?? []) {
        expect(serverCode, `${entry.blueprintId}: ${declaration}`).toContain(declaration);
      }
    }
  });

  // Skipped when the deployment bundles nothing, which FORMAT_BLUEPRINTS_DIR makes a supported
  // configuration rather than a broken checkout.
  it.skipIf(FORMAT_BLUEPRINTS.length === 0)(
      "changes the manifest version when an entry's revision changes", () => {
    let entry = FORMAT_BLUEPRINTS[0];
    let before = formatBlueprintsManifestVersion();
    expect(before).toContain(entry.blueprintId);

    let original = entry.revision;
    try {
      entry.revision = original + 1;
      expect(formatBlueprintsManifestVersion()).not.toBe(before);
    } finally {
      entry.revision = original;
    }
  });

  // Curated text is the input most likely to be edited -- it is the whole point of keeping it in a
  // text file -- and an edit that doesn't reach deployments which already installed would be
  // invisible: the build succeeds and the old wording stays put.
  it.skipIf(FORMAT_BLUEPRINTS.length === 0)(
      "changes the manifest version when curated presentation changes, with no revision bump", () => {
    let entry = FORMAT_BLUEPRINTS[0];
    let before = formatBlueprintsManifestVersion();

    for (let mutate of [
      () => { entry.description += " Now with more detail."; },
      () => { entry.title += " (Beta)"; },
      () => { entry.output = {...entry.output, noun: "Document"}; },
    ]) {
      let restore = {...entry};
      try {
        mutate();
        expect(formatBlueprintsManifestVersion()).not.toBe(before);
        expect(entry.revision).toBe(restore.revision);
      } finally {
        Object.assign(entry, restore);
      }
    }

    expect(formatBlueprintsManifestVersion()).toBe(before);
  });
});
