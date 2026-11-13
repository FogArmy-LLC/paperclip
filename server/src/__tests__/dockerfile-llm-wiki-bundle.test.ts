import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDb,
  getEmbeddedPostgresTestSupport,
  plugins,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { pluginLoader } from "../services/plugin-loader.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
const wikiPluginRoot = path.join(
  repoRoot,
  "packages",
  "plugins",
  "plugin-llm-wiki",
);

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describe("Dockerfile @paperclipai/plugin-llm-wiki bundle contract", () => {
  it("builds @paperclipai/plugin-llm-wiki in the build stage and copies dist + skills into the production runtime stage", () => {
    const buildStageMatch = dockerfile.match(
      /FROM runner-build AS build([\s\S]*?)FROM build AS runner-provider-pack/,
    );
    expect(buildStageMatch?.[1]).toBeTruthy();
    const buildStage = buildStageMatch![1]!;
    expect(buildStage).toContain("pnpm --filter @paperclipai/plugin-llm-wiki build");
    expect(buildStage).toContain("packages/plugins/plugin-llm-wiki/dist/manifest.js");
    expect(buildStage).toContain("packages/plugins/plugin-llm-wiki/dist/worker.js");
    expect(buildStage).toContain("packages/plugins/plugin-llm-wiki/dist/ui/index.js");

    const productionStageMatch = dockerfile.match(
      /FROM base AS production([\s\S]*?)FROM build AS cloud-plugins/,
    );
    expect(productionStageMatch?.[1]).toBeTruthy();
    const productionStage = productionStageMatch![1]!;
    expect(productionStage).toContain(
      "COPY --chown=node:node --from=build /app/packages/plugins/plugin-llm-wiki/dist /app/packages/plugins/plugin-llm-wiki/dist",
    );
    expect(productionStage).toContain(
      "COPY --chown=node:node --from=build /app/packages/plugins/plugin-llm-wiki/skills /app/packages/plugins/plugin-llm-wiki/skills",
    );
    expect(productionStage).toContain(
      "/app/packages/plugins/plugin-llm-wiki/dist/manifest.js",
    );
    expect(productionStage).toContain(
      "/app/packages/plugins/plugin-llm-wiki/dist/worker.js",
    );
    expect(productionStage).toContain(
      "/app/packages/plugins/plugin-llm-wiki/dist/ui/index.js",
    );
  });

  it("produces dist/manifest.js, dist/worker.js, dist/ui/index.js, and skills in packages/plugins/plugin-llm-wiki", () => {
    expect(existsSync(path.join(wikiPluginRoot, "dist", "manifest.js"))).toBe(true);
    expect(existsSync(path.join(wikiPluginRoot, "dist", "worker.js"))).toBe(true);
    expect(existsSync(path.join(wikiPluginRoot, "dist", "ui", "index.js"))).toBe(true);
    expect(existsSync(path.join(wikiPluginRoot, "skills"))).toBe(true);
  });
});

describeEmbeddedPostgres(
  "stateless container startup with prebuilt @paperclipai/plugin-llm-wiki bundle",
  () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
    let statelessRoot = "";
    const originalDisableAutobuild = process.env.PAPERCLIP_DISABLE_PLUGIN_AUTOBUILD;

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase(
        "paperclip-llm-wiki-bundle-",
      );
      db = createDb(tempDb.connectionString);
      statelessRoot = mkdtempSync(
        path.join(os.tmpdir(), "paperclip-stateless-llm-wiki-"),
      );
      const targetDir = path.join(
        statelessRoot,
        "packages",
        "plugins",
        "plugin-llm-wiki",
      );
      cpSync(
        path.join(wikiPluginRoot, "package.json"),
        path.join(targetDir, "package.json"),
      );
      for (const runtimeAsset of [
        "agents",
        "dist",
        "migrations",
        "skills",
        "templates",
      ]) {
        cpSync(
          path.join(wikiPluginRoot, runtimeAsset),
          path.join(targetDir, runtimeAsset),
          { recursive: true },
        );
      }
    }, 20_000);

    afterAll(async () => {
      if (originalDisableAutobuild === undefined) {
        delete process.env.PAPERCLIP_DISABLE_PLUGIN_AUTOBUILD;
      } else {
        process.env.PAPERCLIP_DISABLE_PLUGIN_AUTOBUILD = originalDisableAutobuild;
      }
      if (statelessRoot) {
        rmSync(statelessRoot, { recursive: true, force: true });
      }
      await tempDb?.cleanup();
    });

    it("activates LLM Wiki into ready status with lastError: null without source files or runtime auto-build", async () => {
      process.env.PAPERCLIP_DISABLE_PLUGIN_AUTOBUILD = "1";
      const targetDir = path.join(
        statelessRoot,
        "packages",
        "plugins",
        "plugin-llm-wiki",
      );

      const workerManager = {
        startWorker: vi.fn().mockResolvedValue(undefined),
        call: vi.fn().mockResolvedValue(undefined),
        stopAll: vi.fn().mockResolvedValue(undefined),
      };
      const loader = pluginLoader(
        db,
        {
          localPluginDir: path.join(statelessRoot, "local-plugins"),
          enableLocalFilesystem: true,
          enableNpmDiscovery: false,
        },
        {
          workerManager,
          eventBus: {
            forPlugin: vi.fn(() => ({})),
            subscriptionCount: vi.fn(() => 0),
          },
          jobScheduler: {
            registerPlugin: vi.fn().mockResolvedValue(undefined),
            unregisterPlugin: vi.fn(),
            stop: vi.fn(),
          },
          jobStore: {
            syncJobDeclarations: vi.fn().mockResolvedValue(undefined),
          },
          toolDispatcher: {
            registerPluginTools: vi.fn(),
            unregisterPluginTools: vi.fn(),
          },
          lifecycleManager: {
            markReady: vi.fn(async (pluginId: string) => {
              await db
                .update(plugins)
                .set({ status: "ready", lastError: null })
                .where(eq(plugins.id, pluginId));
            }),
            markError: vi.fn(async (pluginId: string, errMsg: string) => {
              await db
                .update(plugins)
                .set({ status: "error", lastError: errMsg })
                .where(eq(plugins.id, pluginId));
            }),
          },
          buildHostHandlers: vi.fn(() => ({})),
          instanceInfo: {
            instanceId: "stateless-container",
            hostVersion: "1.0.0",
            deploymentMode: "authenticated",
            deploymentExposure: "private",
          },
        } as never,
      );

      await loader.installPlugin({ localPath: targetDir });
      // Simulate fresh stateless container startup where status starts ready/installed and loadAll() activates all plugins
      await db
        .update(plugins)
        .set({ status: "ready", lastError: null })
        .where(eq(plugins.pluginKey, "paperclipai.plugin-llm-wiki"));
      const loadSummary = await loader.loadAll();
      expect(loadSummary.failed).toBe(0);
      expect(loadSummary.succeeded).toBe(1);

      const [record] = await db
        .select()
        .from(plugins)
        .where(eq(plugins.pluginKey, "paperclipai.plugin-llm-wiki"));
      expect(record).toBeDefined();
      expect(record?.pluginKey).toBe("paperclipai.plugin-llm-wiki");
      expect(record?.status).toBe("ready");
      expect(record?.lastError).toBeNull();
      expect(workerManager.startWorker).toHaveBeenCalledWith(
        record!.id,
        expect.objectContaining({
          entrypointPath: path.join(targetDir, "dist", "worker.js"),
        }),
      );
    });
  },
);
