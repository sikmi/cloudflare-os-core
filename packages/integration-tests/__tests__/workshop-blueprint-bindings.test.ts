import { afterAll, beforeAll, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import type { RpcStub } from "capnweb";
import type {
  Overseer, WorkpieceId, WorkpieceSummary, WorkpiecesSubscriber,
} from "@gadgets/workshop-shared/api";
import {
  startHarness, TEST_GATEKEEPER_BINDING, TEST_GATEKEEPER_DIR, TEST_GATEKEEPER_WORKER,
  TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import {
  accountLabel, connect, listConnectedAccounts, nextUsernames, RpcTarget, signUp, stubFor, waitFor,
} from "../src/rpc-client.js";

let harness: Harness;
const network = new NetworkInterceptor();
const OTHER_VENDOR_ID = "other";
const INSTALLER_PRIVATE_VALUE = 73_941_101;
const SECOND_INSTALLER_PRIVATE_VALUE = 73_941_102;
const PENDING_PRIVATE_VALUE = 73_941_103;
const SOURCE_STORAGE_SENTINEL = "sikmi_access_token_source_do_only_91c381";
const INSTALLER_STORAGE_SENTINEL = "installer_private_state_765d22";
const SECOND_INSTALLER_STORAGE_SENTINEL = "second_installer_private_state_a84f10";

const PRIVATE_STATE_SERVER = `
import { DurableObject } from "cloudflare:workers";

export class Gadget extends DurableObject {
  async writePrivateState(value) {
    await this.ctx.storage.kv.put("private-state", value);
  }

  readPrivateState() {
    return this.ctx.storage.kv.get("private-state");
  }
}
`;

type PrivateStateServer = {
  writePrivateState(value: string): Promise<void>;
  readPrivateState(): Promise<string | undefined>;
};

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    enableGadgetExecution: true,
    gatekeepers: [
      {binding: TEST_GATEKEEPER_BINDING, dir: TEST_GATEKEEPER_DIR},
      {
        binding: OTHER_VENDOR_ID.toUpperCase(),
        dir: TEST_GATEKEEPER_DIR,
        patch: config => { config.name = "gatekeeper-test-other"; },
      },
    ],
  });
});

afterAll(async () => {
  try {
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
    await harness?.server.close();
  }
});

function thingUrl(name: string): string {
  return `https://gadgets-test.example/things/${name}`;
}

async function gadgetHead(
    workspace: RpcStub<Overseer>, gadgetId: WorkpieceId): Promise<string> {
  let summary: WorkpieceSummary | undefined;
  let markReady: () => void;
  const ready = new Promise<void>(resolve => { markReady = resolve; });

  class Subscriber extends RpcTarget implements WorkpiecesSubscriber {
    entry(entry: WorkpieceSummary) {
      if (entry.id === gadgetId) summary = entry;
    }
    removed() {}
    ready() { markReady(); }
  }

  using subscriber = stubFor(new Subscriber());
  using _subscription = await workspace.subscribeToWorkpieces(subscriber);
  await ready;
  if (summary?.commitId === undefined) {
    throw new Error(`Gadget ${gadgetId} has no committed head`);
  }
  return summary.commitId;
}

async function addPrivateStateServer(
    workspace: RpcStub<Overseer>, gadgetId: WorkpieceId): Promise<void> {
  const baseCommit = await gadgetHead(workspace, gadgetId);
  const chatId = await workspace.newChat("Add the private-state test server.", null);
  await workspace.submitCodeChange(chatId, {
    generation: 0,
    revision: 0,
    clientId: `blueprint-private-state-${gadgetId}`,
    seq: 1,
    pins: [{gadgetId, baseCommit}],
    change: {[gadgetId]: [["server.js", {set: PRIVATE_STATE_SERVER}]]},
  });
  expect(await workspace.mergeChanges(chatId)).toEqual({outcome: "merged"});
}

async function writePrivateState(
    workspace: RpcStub<Overseer>, value: string): Promise<void> {
  const metadata = await workspace.getMetadata();
  if (metadata.defaultGadgetId === undefined) {
    throw new Error("Workspace has no default Gadget");
  }
  using gadget = await workspace.getGadget(metadata.defaultGadgetId);
  using server = await gadget.connectToGadget() as unknown as RpcStub<PrivateStateServer>;
  await server.writePrivateState(value);
}

async function readPrivateState(workspace: RpcStub<Overseer>): Promise<string | undefined> {
  const metadata = await workspace.getMetadata();
  if (metadata.defaultGadgetId === undefined) {
    throw new Error("Workspace has no default Gadget");
  }
  using gadget = await workspace.getGadget(metadata.defaultGadgetId);
  using server = await gadget.connectToGadget() as unknown as RpcStub<PrivateStateServer>;
  return await server.readPrivateState();
}

async function setBoundValue(workspace: RpcStub<Overseer>, value: number): Promise<void> {
  const metadata = await workspace.getMetadata();
  if (metadata.defaultGadgetId === undefined) {
    throw new Error("Installed workspace has no default Gadget");
  }
  using gadget = await workspace.getGadget(metadata.defaultGadgetId);
  using gatekeeper = await gadget.getBinding("PEOPLE");
  if (!gatekeeper) throw new Error("Installed Gadget has no PEOPLE binding");
  using session = (await gatekeeper.openSession()) as RpcStub<TestSession>;

  const result = session.writeValue(value);
  const pending = await waitFor("the test write to enter the approval queue", async () => {
    const entries = (await workspace.listActions({filter: "pending"})).entries;
    return entries.length === 1 ? entries[0] : null;
  });
  await workspace.approveAction(pending.id);
  await result;
}

async function actionState(label: string): Promise<{
  pending: {id: number, value: number}[];
  value?: number;
  applyCount: number;
}> {
  const response = await harness.fetchWorker(
      TEST_GATEKEEPER_WORKER, "http://gatekeeper-test.test/control/action-state",
      {method: "POST", body: JSON.stringify({label})});
  if (response.status !== 200) {
    throw new Error(`Reading test action state failed with ${response.status}: ${await response.text()}`);
  }
  return await response.json() as {
    pending: {id: number, value: number}[];
    value?: number;
    applyCount: number;
  };
}

it("isolates two installs and rejects stale, extra, or substituted bindings before creation",
    async () => {
      using publicApi = connect(harness.url);
      const [creatorName, installerName, secondInstallerName] =
        nextUsernames("bpcreator", "bpinstaller", "bpsecond");
      if (creatorName === undefined || installerName === undefined ||
          secondInstallerName === undefined) {
        throw new Error("Failed to allocate Blueprint test usernames");
      }
      using creator = await signUp(publicApi, creatorName);
      using installer = await signUp(publicApi, installerName);
      using secondInstaller = await signUp(publicApi, secondInstallerName);

      const formats = await waitFor("bundled output formats to install", async () => {
        const offers = await creator.listOutputFormats();
        return offers.length > 0 ? offers : null;
      });
      const document = formats.find(format => format.output.id === "document");
      if (document === undefined) throw new Error("Document output format is not installed");

      await creator.provisionAmbientAccount(TEST_VENDOR_ID);
      const creatorAccount = await waitFor("the creator account to be provisioned", async () =>
        (await listConnectedAccounts(creator)).find(account => account.vendorId === TEST_VENDOR_ID)
          ?? null);
      using sourceWorkspace = await creator.newGadgetFromBlueprint(document.blueprintId, {});
      const sourceMetadata = await sourceWorkspace.getMetadata();
      if (sourceMetadata.defaultGadgetId === undefined) {
        throw new Error("Source workspace has no default Gadget");
      }
      using sourceGadget = await sourceWorkspace.getGadget(sourceMetadata.defaultGadgetId);
      await addPrivateStateServer(sourceWorkspace, sourceMetadata.defaultGadgetId);
      await writePrivateState(sourceWorkspace, SOURCE_STORAGE_SENTINEL);
      expect(await readPrivateState(sourceWorkspace)).toBe(SOURCE_STORAGE_SENTINEL);
      using peopleGatekeeper = await sourceWorkspace.newGatekeeper(
          creatorAccount.id, thingUrl("people"));
      if (!peopleGatekeeper) throw new Error("Failed to create the People test gatekeeper");
      await sourceGadget.bind("PEOPLE", await peopleGatekeeper.getId());
      const blueprint = await sourceGadget.createBlueprint(
          "People viewer", "A Blueprint with one declared capability");

      await installer.provisionAmbientAccount(TEST_VENDOR_ID);
      const installerAccount = await waitFor("the installer account to be provisioned", async () =>
        (await listConnectedAccounts(installer)).find(account => account.vendorId === TEST_VENDOR_ID)
          ?? null);
      expect(installerAccount.id).toBe(creatorAccount.id);
      expect(accountLabel(installerAccount)).not.toBe(accountLabel(creatorAccount));
      await installer.provisionAmbientAccount(OTHER_VENDOR_ID);
      const otherAccount = await waitFor("the other-vendor account to be provisioned", async () =>
        (await listConnectedAccounts(installer)).find(account => account.vendorId === OTHER_VENDOR_ID)
          ?? null);
      const peopleAssignment = {
        type: "gatekeeper" as const,
        accountId: installerAccount.id,
        resourceUrl: thingUrl("installer-people"),
      };

      const initialWorkspaces = await installer.listGadgets();
      await expect(installer.newGadgetFromBlueprint(blueprint.id, {}))
        .rejects.toThrow("Missing binding assignment: PEOPLE");
      await expect(installer.newGadgetFromBlueprint(blueprint.id, {
        PEOPLE: peopleAssignment,
        UNDECLARED: peopleAssignment,
      })).rejects.toThrow("Unknown binding name: UNDECLARED");
      await expect(installer.newGadgetFromBlueprint(blueprint.id, {
        PEOPLE: {type: "agentSpawner", modelId: null},
      })).rejects.toThrow('Binding "PEOPLE" type mismatch.');
      await expect(installer.newGadgetFromBlueprint(blueprint.id, {
        PEOPLE: {...peopleAssignment, accountId: 999_999},
      })).rejects.toThrow("No such account.");
      await expect(installer.newGadgetFromBlueprint(blueprint.id, {
        PEOPLE: {...peopleAssignment, accountId: otherAccount.id},
      })).rejects.toThrow("Invalid account selection for this service.");
      await expect(installer.newGadgetFromBlueprint(blueprint.id, {
        PEOPLE: {...peopleAssignment, resourceUrl: "https://gadgets-test.example/other/substitute"},
      })).rejects.toThrow('Invalid resource selection for binding "PEOPLE".');
      expect(await installer.listGadgets()).toEqual(initialWorkspaces);

      using installedWorkspace = await installer.newGadgetFromBlueprint(blueprint.id, {
        PEOPLE: peopleAssignment,
      });
      await secondInstaller.provisionAmbientAccount(TEST_VENDOR_ID);
      const secondInstallerAccount = await waitFor(
          "the second installer account to be provisioned", async () =>
            (await listConnectedAccounts(secondInstaller))
              .find(account => account.vendorId === TEST_VENDOR_ID) ?? null);
      expect(secondInstallerAccount.id).toBe(installerAccount.id);
      expect(accountLabel(secondInstallerAccount)).not.toBe(accountLabel(installerAccount));
      using secondInstalledWorkspace = await secondInstaller.newGadgetFromBlueprint(blueprint.id, {
        PEOPLE: {
          type: "gatekeeper",
          accountId: secondInstallerAccount.id,
          resourceUrl: thingUrl("second-installer-people"),
        },
      });
      expect((await secondInstalledWorkspace.getMetadata()).id)
        .not.toBe((await installedWorkspace.getMetadata()).id);

      await writePrivateState(installedWorkspace, INSTALLER_STORAGE_SENTINEL);
      await writePrivateState(secondInstalledWorkspace, SECOND_INSTALLER_STORAGE_SENTINEL);
      expect(await readPrivateState(installedWorkspace)).toBe(INSTALLER_STORAGE_SENTINEL);
      expect(await readPrivateState(secondInstalledWorkspace))
        .toBe(SECOND_INSTALLER_STORAGE_SENTINEL);
      expect(await readPrivateState(sourceWorkspace)).toBe(SOURCE_STORAGE_SENTINEL);

      await setBoundValue(installedWorkspace, INSTALLER_PRIVATE_VALUE);
      await setBoundValue(secondInstalledWorkspace, SECOND_INSTALLER_PRIVATE_VALUE);
      expect(await actionState(accountLabel(installerAccount)))
        .toEqual({pending: [], value: INSTALLER_PRIVATE_VALUE, applyCount: 1});
      expect(await actionState(accountLabel(secondInstallerAccount)))
        .toEqual({pending: [], value: SECOND_INSTALLER_PRIVATE_VALUE, applyCount: 1});
      expect(await actionState(accountLabel(creatorAccount)))
        .toEqual({pending: [], applyCount: 0});

      {
        const installedMetadata = await installedWorkspace.getMetadata();
        using installedGadget = await installedWorkspace.getGadget(
            installedMetadata.defaultGadgetId!);
        using installedGatekeeper = await installedGadget.getBinding("PEOPLE");
        if (!installedGatekeeper) throw new Error("Installed Gadget has no PEOPLE binding");
        using installedSession = (await installedGatekeeper.openSession()) as RpcStub<TestSession>;
        expect(await installedSession.readValue()).toBe(42);
        const pendingResult = installedSession.writeValue(PENDING_PRIVATE_VALUE);
        const pending = await waitFor("the private action to enter the approval queue", async () => {
          const entries = (await installedWorkspace.listActions({filter: "pending"})).entries;
          return entries.length === 1 ? entries[0] : null;
        });

        const archive = new Uint8Array(
            await new Response(await publicApi.downloadBlueprint(blueprint.id)).arrayBuffer());
        const metadataLength = new DataView(
            archive.buffer, archive.byteOffset, archive.byteLength).getUint32(12);
        const contentOffset = 24 + metadataLength;
        const decoder = new TextDecoder();
        const metadataText = decoder.decode(archive.subarray(24, contentOffset));
        const snapshotText = decoder.decode(gunzipSync(archive.subarray(contentOffset)));
        const exportedMetadata = JSON.parse(metadataText) as Record<string, unknown> & {
          bindings: Record<string, Record<string, unknown>>;
        };
        expect(Object.keys(exportedMetadata).toSorted()).toEqual([
          "author", "bindings", "created", "description", "lastUpdated", "output", "title",
          "version",
        ]);
        expect(Object.keys(exportedMetadata.bindings)).toEqual(["PEOPLE"]);
        expect(Object.keys(exportedMetadata.bindings.PEOPLE).toSorted()).toEqual([
          "description", "gatekeeperName", "title", "type", "typeUrlPattern",
        ]);
        const exportedText = `${metadataText}\n${snapshotText}`;
        for (const privateValue of [
          accountLabel(creatorAccount), accountLabel(installerAccount),
          accountLabel(secondInstallerAccount), thingUrl("installer-people"),
          thingUrl("second-installer-people"), String(INSTALLER_PRIVATE_VALUE),
          String(SECOND_INSTALLER_PRIVATE_VALUE), String(PENDING_PRIVATE_VALUE),
          SOURCE_STORAGE_SENTINEL, INSTALLER_STORAGE_SENTINEL,
          SECOND_INSTALLER_STORAGE_SENTINEL,
        ]) {
          expect(exportedText).not.toContain(privateValue);
        }

        await installedWorkspace.rejectAction(pending.id);
        await expect(pendingResult).rejects.toThrow();
      }

      using payrollGatekeeper = await sourceWorkspace.newGatekeeper(
          creatorAccount.id, thingUrl("payroll"));
      if (!payrollGatekeeper) throw new Error("Failed to create the Payroll test gatekeeper");
      await sourceGadget.bind("PAYROLL", await payrollGatekeeper.getId());
      await sourceWorkspace.updateBlueprint(blueprint.id, {updateBindings: true});

      const updatedBlueprint = await publicApi.getBlueprint(blueprint.id);
      expect(Object.keys(updatedBlueprint?.metadata.bindings ?? {}).toSorted())
        .toEqual(["PAYROLL", "PEOPLE"]);
      const beforeStaleInstall = await installer.listGadgets();
      await expect(installer.newGadgetFromBlueprint(blueprint.id, {
        PEOPLE: peopleAssignment,
      })).rejects.toThrow("Missing binding assignment: PAYROLL");
      expect(await installer.listGadgets()).toEqual(beforeStaleInstall);

      await secondInstalledWorkspace.deleteSelf();
      await installedWorkspace.deleteSelf();
      await sourceWorkspace.deleteBlueprint(blueprint.id);
      await sourceWorkspace.deleteSelf();
    });
