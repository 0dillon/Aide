import { api } from "../../convex/_generated/api";
import { convexClient } from "../convex-server";
import { worker } from "./state";

// A freshly created Convex deployment — a teammate's, a judge's, a preview
// branch's — starts completely empty, so the demo identities that every
// signed-out visitor falls back to would not exist and the account switcher
// would be blank. Seeding runs automatically on first use instead of being a
// setup step someone has to know about. The mutation is idempotent, so this is
// safe to call on every request and safe to run concurrently.

let seeded: Promise<void> | null = null;

export function ensureSeeded(): Promise<void> {
  if (!seeded) {
    seeded = convexClient()
      .mutation(api.accounts.seedDefaults, {
        accounts: [
          {
            key: worker.id,
            name: worker.name,
            role: "worker" as const,
            email: worker.email,
            skills: [...worker.skills],
            bio: worker.bio,
            createdAt: Date.now(),
          },
          {
            key: "demo-employer",
            name: "ClearVoice Media",
            role: "employer" as const,
            skills: [],
            bio: "",
            createdAt: Date.now(),
          },
        ],
      })
      .then(() => undefined)
      .catch((e) => {
        seeded = null; // transient failure — let the next request try again
        throw e;
      });
  }
  return seeded;
}
