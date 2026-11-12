import { LocalStore } from "../adapters/local/store.mjs";
import { makeCrypto } from "../adapters/local/crypto.mjs";
import { AccessService } from "../core/access.mjs";
import { DataService } from "../core/data.mjs";
export const syntheticRoutes = [
  { id: "landing", label: "Sample landing" },
  { id: "library", label: "Sample library" },
  { id: "studio", label: "Sample studio" },
];
export function createSystem({
  dir,
  secrets,
  clock = Date.now,
  synthetic = false,
  routes = syntheticRoutes,
}) {
  const store = new LocalStore(dir, clock),
    crypto = makeCrypto(secrets);
  return {
    store,
    crypto,
    now: clock,
    access: new AccessService(store, crypto, clock),
    data: new DataService(store, crypto, clock, routes, { synthetic }),
    close: () => store.close(),
  };
}
