import { api } from "../../convex/_generated/api";
import { convexClient } from "../convex-server";
import { worker } from "./state";

// The two BMONI sandbox personas. Only these BVNs resolve, so the demo worker
// and demo employer ARE these people — the names on the payments page, the
// virtual accounts money is paid into, and the identities BMONI onboards are
// all one and the same.
//
// Seeded rather than collected because there is nobody to collect them from:
// a judge opening the app for the first time falls straight into demo-worker,
// and provisioning refuses without a name split, an E.164 phone and a BVN.
//
// The emails are deliberately on a real domain. BMONI rejects card issuance
// with "The email address on your account is invalid" for made-up ones like
// @aide.test, and it says so only at the card step — long after the account
// looks fine.
const PERSONAS = {
  worker: {
    firstName: "Bunch",
    lastName: "Dillon",
    phoneNumber: "+2348000000000",
    bvn: "95888168924",
  },
  employer: {
    firstName: "Samson",
    lastName: "Jabo",
    phoneNumber: "+2348000000001",
    bvn: "22222222222",
  },
} as const;

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
            ...PERSONAS.worker,
          },
          {
            key: "demo-employer",
            name: "ClearVoice Media",
            role: "employer" as const,
            skills: [],
            bio: "",
            createdAt: Date.now(),
            ...PERSONAS.employer,
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
