import { api } from "../../convex/_generated/api";
import { convexClient } from "../convex-server";
import { worker } from "./state";
import { currentDeployment, personaPhone } from "./persona-phone";

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
// The phone numbers are DERIVED, not the documented persona ones. BMONI
// enforces global uniqueness on phoneNumber across every team on the shared
// sandbox, so +2348000000000 and +2348000000001 are long since taken — and the
// phone is not what identity matching uses. See lib/store/persona-phone.ts.
const PERSONAS = {
  worker: {
    firstName: "Bunch",
    lastName: "Dillon",
    bvn: "95888168924",
  },
  employer: {
    firstName: "Samson",
    lastName: "Jabo",
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
            phoneNumber: personaPhone(worker.id, currentDeployment()),
          },
          {
            key: "demo-employer",
            name: "ClearVoice Media",
            role: "employer" as const,
            // BMONI will not create a user without one, and an employer with no
            // BMONI user cannot pay anybody.
            email: "aide-demo-employer@aide.test",
            skills: [],
            bio: "",
            createdAt: Date.now(),
            ...PERSONAS.employer,
            phoneNumber: personaPhone("demo-employer", currentDeployment()),
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
