import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { AuthorityStore } from "./authority-store.mjs";
import { configuration, objectName, basename } from "./config.mjs";
import { plain, serveAssets } from "./assets.mjs";
import { AccessService } from "../../core/access.mjs";
import { DataService } from "../../core/data.mjs";
import { makeCrypto } from "../local/crypto.mjs";
import { createHandler, base } from "../../server/http.mjs";
import { requireThat } from "../../core/contracts.mjs";
export class QuietStatsAuthority extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      const config = configuration(env);
      this.store = new AuthorityStore(ctx.storage);
      this.crypto = makeCrypto(config.secrets, env.DATASET_NAMESPACE);
      const contract = this.crypto.digest(
        JSON.stringify({
          namespace: env.DATASET_NAMESPACE,
          routes: config.routes,
          origin: config.origin,
        }),
      );
      requireThat(
        !this.store.get("configuration") ||
          this.store.get("configuration") === contract,
        503,
        "invalid_configuration",
      );
      this.store.tx(() => this.store.set("configuration", contract));
      this.access = new AccessService(this.store, this.crypto, Date.now, {
        hosted: true,
      });
      this.data = new DataService(
        this.store,
        this.crypto,
        Date.now,
        config.routes,
        { production: true, qualified: config.qualified },
      );
      this.handler = createHandler(
        { access: this.access, data: this.data, now: Date.now },
        { origin: config.origin },
      );
    });
  }
  // Private namespace RPC only. Never forwarded from a public URL or request body.
  issueSetupGrant(replace = false) {
    requireThat(typeof replace === "boolean", 400);
    return this.access.issueGrant(replace);
  }
  setCollectionPolicy(enabled) {
    this.data.setPolicy(enabled);
    return this.data.status();
  }
  operatorStatus() {
    return { enrolled: !!this.access.state().seed, ...this.data.status() };
  }
  rotateDataKey() {
    return this.data.rotateDataKey();
  }
  authorizePage(request, kind) {
    try {
      requireThat(["normal", "access"].includes(kind), 403);
      const name = kind === "normal" ? "__Host-qs_sid" : "__Host-qs_access";
      const values = (request.headers.get("cookie") || "")
        .split(";")
        .map((x) => x.trim())
        .filter((x) => x.startsWith(name + "="));
      requireThat(values.length === 1, 401);
      this.access.authorize(values[0].slice(name.length + 1), kind);
      return true;
    } catch {
      return false;
    }
  }
  async handle(request, source) {
    return this.handler(request, { source });
  }
}
// Named capability, available only to authenticated Cloudflare service bindings.
// Default HTTP routing below never forwards to these methods.
export class QuietStatsOperator extends WorkerEntrypoint {
  issueSetupGrant() {
    return this.env.AUTHORITY.getByName(objectName).issueSetupGrant();
  }
  setCollectionPolicy(enabled) {
    requireThat(typeof enabled === "boolean", 400);
    return this.env.AUTHORITY.getByName(objectName).setCollectionPolicy(
      enabled,
    );
  }
  operatorStatus() {
    return this.env.AUTHORITY.getByName(objectName).operatorStatus();
  }
  fetch(_request) {
    return plain("Not found", 404);
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!(
      url.pathname === basename ||
      url.pathname.startsWith(basename + "/") ||
      url.pathname.startsWith("/api/metrics/")
    ))
      return plain("Not found");
    try {
      requireThat(
        url.origin === configuration(env).origin && env.AUTHORITY && env.ASSETS,
        503,
      );
      const authority = env.AUTHORITY.getByName(objectName);
      if (url.pathname.startsWith("/api/metrics/")) {
        if (!url.pathname.startsWith(base + "/")) return plain("Not found");
        return await authority.handle(
          request,
          request.headers.get("cf-connecting-ip") || "unavailable",
        );
      }
      return await serveAssets(request, env, authority);
    } catch {
      return plain("Temporarily unavailable", 503);
    }
  },
};
