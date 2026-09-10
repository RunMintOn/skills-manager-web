import { mkdtemp, rm } from "node:fs/promises"
import { Readable, Writable } from "node:stream"
import { tmpdir } from "node:os"
import nodePath from "node:path"
import type { IncomingMessage, Server, ServerResponse } from "node:http"

const describeMac = process.platform === "darwin" ? describe : describe.skip

describeMac("macOS localhost workspace", () => {
  let root: string
  let server: Server

  beforeAll(async () => {
    root = await mkdtemp(nodePath.join(tmpdir(), "skills-manager-macos-server-"))
    process.env.SKILLS_MANAGER_CONFIG = nodePath.join(root, "config.json")
    const loaded = await import("./server.ts")
    server = loaded.server
  })

  afterAll(async () => {
    delete process.env.SKILLS_MANAGER_CONFIG
    await rm(root, { recursive: true, force: true })
  })

  async function request(path: string, method = "GET", body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as Readable & Partial<IncomingMessage>
    request.method = method
    request.url = path
    request.headers = { host: "127.0.0.1", "content-type": "application/json" }
    let text = ""
    const response = new Writable({ write(chunk, _encoding, callback) { text += chunk.toString(); callback() } }) as Writable & Partial<ServerResponse>
    response.statusCode = 200
    response.setHeader = (() => response) as ServerResponse["setHeader"]
    response.end = ((chunk?: unknown) => { if (chunk !== undefined) text += String(chunk) }) as ServerResponse["end"]
    const handler = server.listeners("request")[0] as (request: IncomingMessage, response: ServerResponse) => Promise<void>
    await handler(request as IncomingMessage, response as ServerResponse)
    return { status: response.statusCode ?? 500, body: JSON.parse(text) as Record<string, unknown> }
  }

  it("reports a Mac workspace with built-in Agents without scanning fixtures", async () => {
    const response = await request("/api/init")
    expect(response.status).toBe(200)
    const body = response.body as unknown as { runtimeHost: string; config: { exists: boolean; config: { vault: { path: string; host: string }; agents: Array<{ path: string }> } }; vault: { path: string; summary: { total: number } }; agents: unknown[]; safety: { sync: string } }
    expect(body.runtimeHost).toBe("macos")
    expect(body.config.exists).toBe(false)
    expect(body.config.config.vault).toEqual({ path: "", host: "macos" })
    expect(body.config.config.agents.map((agent) => agent.path)).toEqual([
      "$HOME/.codex/skills",
      "$HOME/.pi/agent/skills",
      "$HOME/.agents/skills",
    ])
    expect(body.vault).toMatchObject({ path: "", summary: { total: 0 } })
    expect(body.agents).toHaveLength(3)
    expect(body.safety.sync).toBe("disabled")
  })

  it("rejects legacy hosts and mirror requests on macOS", async () => {
    const configResponse = await request("/api/config", "PUT", { schemaVersion: 1, vault: { path: "/tmp/vault", host: "wsl" }, agents: [] })
    expect(configResponse.status).toBe(400)

    const mirrorResponse = await request("/api/mirror-sync/plan", "POST", {})
    expect(mirrorResponse.status).toBe(400)
  })

  it("saves a local macOS Vault and Agent configuration", async () => {
    const response = await request("/api/config", "PUT", {
      schemaVersion: 1,
      vault: { path: "/Users/lee/Vault", host: "macos" },
      agents: [{ id: "mac-agent", name: "Mac Agent", path: "/Users/lee/Agent", host: "macos" }],
    })
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      exists: true,
      config: {
        vault: { path: "/Users/lee/Vault", host: "macos" },
        agents: [{ id: "mac-agent", path: "/Users/lee/Agent", host: "macos" }],
      },
    })
  })
})
