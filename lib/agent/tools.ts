import { tool } from "ai";
import { z } from "zod";
import * as store from "../store";
import { registerPayout, confirmWithdrawal } from "../payments";
import type { Account } from "../store";

// Aide's tools, built per-request around the signed-in account so the model
// acts as the right person (worker vs employer). Every money fact comes from
// a real server call — the model never decides financial truth, it only
// narrates what a tool returns.
export function makeTools(account: Account) {
  return {
    open_page: tool({
      description:
        "Open one of Aide's screens for the user: 'home' (talking to Aide), 'jobs' (job listings and spoken assessments; for employers, their posted gigs), 'payments' (balance, receiving money, withdrawals), 'profile' (their account, completed jobs, verified skills), or 'signup' (create an account). Use when the user asks to go to, open, or see one of these screens. A small version of you follows them there, so keep talking naturally.",
      parameters: z.object({
        page: z.enum(["home", "jobs", "payments", "profile", "signup"]),
        section: z
          .enum(["listings", "external", "balance", "receive", "send", "history", "bio", "skills", "applications"])
          .optional()
          .describe(
            "scroll to the part being discussed — jobs: listings|external; payments: balance|receive|send|history; profile: bio|skills|applications",
          ),
      }),
      execute: async ({ page, section }) => ({ ok: true, page, section }),
    }),

    filter_jobs: tool({
      description:
        "Filter the jobs page for the worker — by keyword (e.g. 'virtual assistant', 'transcription'), pay range in Naira, and whether an assessment is required. The jobs page opens with the filters applied; the worker can also adjust them on screen. Use when they ask things like 'show VA jobs paying between 12 and 20 thousand'.",
      parameters: z.object({
        keyword: z.string().optional().describe("skill or title keyword"),
        minPay: z.number().optional().describe("minimum pay in Naira"),
        maxPay: z.number().optional().describe("maximum pay in Naira"),
        requiresAssessment: z.boolean().optional().describe("true = only jobs with an assessment, false = only without"),
      }),
      execute: async ({ keyword, minPay, maxPay, requiresAssessment }) => {
        const filtered = (await store.listJobs()).filter((j) => {
          const kw = keyword?.trim().toLowerCase();
          if (kw && !j.title.toLowerCase().includes(kw) && !j.skill.toLowerCase().includes(kw)) return false;
          if (minPay !== undefined && j.pay < minPay) return false;
          if (maxPay !== undefined && j.pay > maxPay) return false;
          if (requiresAssessment !== undefined && j.requiresAssessment !== requiresAssessment) return false;
          return true;
        });
        return {
          ok: true,
          filters: { keyword, minPay, maxPay, requiresAssessment },
          matches: filtered.map((j) => ({ id: j.id, title: j.title, pay: j.pay, skill: j.skill })),
        };
      },
    }),

    create_account: tool({
      description:
        "Create the user's account by voice. Ask for their name and whether they want to join as a worker (find and do gigs) or an employer (post work and pay workers), confirm both back to them, then call this. The browser is signed in automatically.",
      parameters: z.object({
        name: z.string().describe("the user's name, as they said it"),
        role: z.enum(["worker", "employer"]),
      }),
      execute: async ({ name, role }) => {
        const acc = await store.createAccount(name, role);
        // Every new account gets its own live API wallet, minted in the
        // background so voice signup never waits on the payment rail.
        store.provisionWalletInBackground(acc.id);
        return { ok: true, userId: acc.id, name: acc.name, role: acc.role };
      },
    }),

    switch_account: tool({
      description:
        "Switch the user to another account on this device, by name or role (e.g. 'my employer account', 'ClearVoice Media'). Confirm which account before switching. The browser is signed in to it automatically.",
      parameters: z.object({ query: z.string().describe("account name, or 'worker'/'employer' if unambiguous") }),
      execute: async ({ query }) => {
        const q = query.trim().toLowerCase();
        // Voice switching covers only passwordless demo identities — real
        // credentialed accounts require typing a password on the login page.
        const all = (await store.listAccounts()).filter((a) => !a.passwordHash);
        const matches = all.filter(
          (a) => a.name.toLowerCase().includes(q) || a.role === q || a.id === query.trim(),
        );
        if (matches.length === 0)
          return { ok: false, message: "No account matches that.", accounts: all.map((a) => `${a.name} (${a.role})`) };
        if (matches.length > 1)
          return { ok: false, message: "More than one account matches — ask which one.", accounts: matches.map((a) => `${a.name} (${a.role})`) };
        const acc = matches[0];
        return { ok: true, userId: acc.id, name: acc.name, role: acc.role };
      },
    }),

    post_gig: tool({
      description:
        "Post a new gig for the employer, fully by voice — including multiple-choice assessments and time limits, everything the on-screen form can do. Collect the title, skill, and pay. Ask whether applicants must pass an assessment; if so, ask whether it is a spoken (oral) question or multiple choice. For oral, collect the exact question. For multiple choice, collect each question with its options and which option is correct (build the mcqQuestions array). Optionally collect a time limit. Read everything back and get a spoken yes before calling. Only works for employer accounts.",
      parameters: z.object({
        title: z.string().describe("gig title, e.g. 'Transcribe a 20 minute podcast'"),
        skill: z.string().describe("the skill or gig type, e.g. transcription"),
        pay: z.number().describe("pay in Naira"),
        requiresAssessment: z.boolean(),
        assessmentType: z
          .enum(["oral", "mcq"])
          .optional()
          .describe("'oral' = one spoken question; 'mcq' = multiple choice. Required when requiresAssessment is true."),
        assessmentQuestion: z.string().optional().describe("the spoken question applicants must answer (oral assessments only)"),
        mcqQuestions: z
          .array(
            z.object({
              question: z.string().describe("the question text"),
              options: z.array(z.string()).min(2).max(6).describe("2 to 6 answer options, in the order read aloud"),
              correctIndex: z.number().int().describe("0-based index of the correct option"),
            }),
          )
          .optional()
          .describe("the questions for a multiple choice assessment"),
        timeLimitMinutes: z.number().optional().describe("optional time limit for the assessment, in minutes (up to 60)"),
      }),
      execute: async ({ title, skill, pay, requiresAssessment, assessmentType, assessmentQuestion, mcqQuestions, timeLimitMinutes }) => {
        if (account.role !== "employer") {
          return { ok: false, message: "Only employer accounts can post gigs. Offer to create an employer account first." };
        }
        const v = store.validateGig({
          title,
          skill,
          pay,
          requiresAssessment,
          // Default to oral if they asked for an assessment without saying which.
          assessmentType: requiresAssessment ? assessmentType || "oral" : undefined,
          assessmentQuestion,
          mcqQuestions,
          timeLimit: timeLimitMinutes !== undefined ? Math.round(timeLimitMinutes * 60) : undefined,
        });
        if (!v.ok) return { ok: false, message: v.message };
        const job = await store.postJob({ ...v.gig, employer: account.name, employerAccountId: account.id });
        return {
          ok: true,
          jobId: job.id,
          title: job.title,
          pay: job.pay,
          requiresAssessment: job.requiresAssessment,
          assessmentType: job.assessmentType,
          questionCount: job.mcqQuestions?.length,
          timeLimit: job.timeLimit,
        };
      },
    }),

    review_applicants: tool({
      description:
        "For employers: list the applications on the employer's own posted gigs, with worker name and status. 'assessed' with skillVerified true means they passed the assessment and are ready to hire.",
      parameters: z.object({}),
      execute: async () => {
        if (account.role !== "employer") return { ok: false, message: "Only employer accounts can review applicants." };
        const jobs = (await store.listJobs()).filter((j) => store.ownsJob(account, j));
        // Each applicant's details come from their OWN Convex account. This
        // used to read one hardcoded worker, so every applicant an employer
        // reviewed carried that worker's name, skills and bio.
        const applications = await Promise.all(
          (await store.listApplicantsForJobs(jobs.map((j) => j.id)))
            .map(async (a) => ({
              ...(await (async () => {
                const applicant = await store.getAccount(a.accountId);
                return {
                  jobId: a.jobId,
                  // The employer needs this to name a specific applicant when
                  // there is more than one on a gig.
                  workerAccountId: a.accountId,
                  gig: (await store.getJob(a.jobId))?.title,
                  worker: applicant.name,
                  status: a.status,
                  skillVerified: a.verified,
                  assessmentResult: a.assessmentResult,
                  workerSkills: applicant.skills ?? [],
                  workerBio: applicant.bio ?? "",
                };
              })()),
            })),
        );
        return { ok: true, applications };
      },
    }),

    hire_worker: tool({
      description:
        "For employers: hire the worker on one of the employer's own gigs, normally after they passed the assessment. Confirm with the employer aloud before calling.",
      parameters: z.object({
        jobId: z.string(),
        workerAccountId: z
          .string()
          .optional()
          .describe("which applicant to act on (workerAccountId from review_applicants); omit when the gig has only one"),
      }),
      execute: async ({ jobId, workerAccountId }) => {
        if (account.role !== "employer") return { ok: false, message: "Only employer accounts can hire." };
        const job = await store.getJob(jobId);
        if (!job || !store.ownsJob(account, job)) {
          return { ok: false, message: "That gig is not one of this employer's postings." };
        }
        const chosen = await store.resolveApplicant(jobId, workerAccountId);
        if (!chosen.ok) return { ok: false, message: chosen.message };
        const app = await store.hireWorker(chosen.accountId, jobId);
        if (!app) return { ok: false, message: "No application on that gig yet." };
        store.publishEvent(chosen.accountId, {
          type: "notify",
          message: `Great news from ${job.employer}: you have been hired for ${job.title}. Say "help me with my job" and I will guide you through the task.`,
        });
        return { ok: true, status: app.status, gig: job.title };
      },
    }),

    reject_worker: tool({
      description:
        "For employers: decline the applicant on one of their gigs. Confirm with the employer aloud before calling. The worker is notified kindly by Aide.",
      parameters: z.object({
        jobId: z.string(),
        workerAccountId: z
          .string()
          .optional()
          .describe("which applicant to act on (workerAccountId from review_applicants); omit when the gig has only one"),
      }),
      execute: async ({ jobId, workerAccountId }) => {
        if (account.role !== "employer") return { ok: false, message: "Only employer accounts can reject applicants." };
        const job = await store.getJob(jobId);
        if (!job || !store.ownsJob(account, job)) {
          return { ok: false, message: "That gig is not one of this employer's postings." };
        }
        const chosen = await store.resolveApplicant(jobId, workerAccountId);
        if (!chosen.ok) return { ok: false, message: chosen.message };
        const app = await store.rejectWorker(chosen.accountId, jobId);
        if (!app) return { ok: false, message: "No application on that gig yet." };
        store.publishEvent(chosen.accountId, {
          type: "notify",
          message: `An update on ${job.title} from ${job.employer}: they went with another applicant this time. Your assessment result stays on your profile — I can find you more jobs whenever you're ready.`,
        });
        return { ok: true, status: app.status, gig: job.title };
      },
    }),

    scan_external_jobs: tool({
      description:
        "Search the open web (Remotive's public listings of real remote jobs) for openings matching the worker's skills and resume. Results are saved under External jobs on the jobs page. Read back the titles and companies found.",
      parameters: z.object({}),
      execute: async () => {
        const { searchExternalJobs } = await import("../external");
        const verified = (await store.getApplications(account.id)).filter((a) => a.verified);
        const verifiedSkills = (await Promise.all(verified.map(async (a) => (await store.getJob(a.jobId))?.skill))).filter(
          (s): s is string => !!s,
        );
        const skills = [...new Set([...(account.skills ?? []), ...verifiedSkills])];
        const jobs = await searchExternalJobs(skills);
        await store.setExternalJobs(store.getWorker().id, jobs);
        return {
          ok: true,
          matchedSkills: skills,
          found: jobs.map((j) => ({ id: j.id, title: j.title, company: j.company })),
        };
      },
    }),

    track_external_job: tool({
      description:
        "Record that the worker is applying to one of the external listings found by scan_external_jobs, so their submission is tracked on the jobs page. You cannot fill the external site's form for them — tell them the listing is open on their jobs page and you've tracked the application.",
      parameters: z.object({ externalJobId: z.string() }),
      execute: async ({ externalJobId }) => {
        const app = await store.trackExternalJob(store.getWorker().id, externalJobId);
        if (!app) return { ok: false, message: "No external listing with that id — scan for jobs first." };
        return { ok: true, tracked: { title: app.title, company: app.company, url: app.url } };
      },
    }),

    mark_gig_paid: tool({
      description:
        "For employers: mark one of their gigs as paid. This ONLY succeeds when a confirmed live API payment actually covers the gig's pay — if it fails, tell the employer to send the money from the payout desk first. Never claim a gig is paid unless this returns ok.",
      parameters: z.object({
        jobId: z.string(),
        workerAccountId: z
          .string()
          .optional()
          .describe("which applicant to act on (workerAccountId from review_applicants); omit when the gig has only one"),
      }),
      execute: async ({ jobId, workerAccountId }) => {
        if (account.role !== "employer") return { ok: false, message: "Only employer accounts can mark gigs paid." };
        const job = await store.getJob(jobId);
        if (!job || !store.ownsJob(account, job)) {
          return { ok: false, message: "That gig is not one of this employer's postings." };
        }
        const chosen = await store.resolveApplicant(jobId, workerAccountId);
        if (!chosen.ok) return { ok: false, message: chosen.message };
        const coverage = await store.verifyPaymentCoverage(chosen.accountId, jobId);
        if (!coverage.ok) return { ok: false, message: coverage.message };
        const app = await store.payWorker(chosen.accountId, jobId);
        if (!app) return { ok: false, message: "No application on that gig yet." };
        return { ok: true, status: app.status, gig: job.title, message: "Confirmed payment covers this gig; it is now marked paid." };
      },
    }),

    list_jobs: tool({
      description:
        "List available jobs the worker can do, optionally filtered by a skill or keyword the user mentioned (e.g. transcription, translation, phone support).",
      parameters: z.object({ skill: z.string().optional().describe("skill or keyword to filter by") }),
      execute: async ({ skill }) =>
        (await store.listJobs(skill)).map((j) => ({ id: j.id, title: j.title, pay: j.pay, skill: j.skill, employer: j.employer })),
    }),

    apply_to_job: tool({
      description: "Apply the worker to a job by its id. Confirm with the user first.",
      parameters: z.object({ jobId: z.string() }),
      execute: async ({ jobId }) => {
        const job = await store.getJob(jobId);
        if (!job) return { ok: false, message: "No job with that id." };
        const app = await store.apply(account.id, jobId);
        if (app.status === "cancelled") {
          return { ok: false, message: "The worker cancelled the assessment for this job earlier, so they can no longer apply to it." };
        }
        return { ok: true, jobId: job.id, applicationId: app.id, title: job.title, needsAssessment: job.requiresAssessment };
      },
    }),

    get_applications: tool({
      description: "List the worker's current job applications and their status.",
      parameters: z.object({}),
      execute: async () =>
        await Promise.all((await store.getApplications(account.id)).map(async (a) => ({ ...a, job: (await store.getJob(a.jobId))?.title }))),
    }),

    withdraw_application: tool({
      description:
        "Withdraw the worker's application to a job they applied for but have not started the assessment on. Confirm aloud first. If the assessment has already begun this is refused — say so plainly rather than implying it worked.",
      parameters: z.object({ jobId: z.string() }),
      execute: async ({ jobId }) => {
        const job = await store.getJob(jobId);
        if (!job) return { ok: false, message: "No job with that id." };
        const r = await store.unapply(account.id, jobId);
        return { ok: r.ok, gig: job.title, message: r.message };
      },
    }),

    delete_gig: tool({
      description:
        "For employers: take down a gig they posted. IRREVERSIBLE, and it also withdraws any pending applications on it, so warn them of both and get an explicit spoken yes first. Refused once a worker has been hired or paid for the gig.",
      parameters: z.object({ jobId: z.string() }),
      execute: async ({ jobId }) => {
        if (account.role !== "employer") return { ok: false, message: "Only employer accounts can remove gigs." };
        const job = await store.getJob(jobId);
        if (!job) return { ok: false, message: "No job with that id." };
        const r = await store.deletePostedJob(account.id, jobId);
        return { ok: r.ok, gig: job.title, message: r.message };
      },
    }),

    delete_message: tool({
      description:
        "Delete a message the user themselves sent in a gig's onboarding thread. Read the message back and get a spoken yes first. Only their own messages can be deleted — pass the messageId from read_messages.",
      parameters: z.object({ messageId: z.string() }),
      execute: async ({ messageId }) => {
        const r = await store.deleteMessage(account.id, messageId);
        return { ok: r.ok, message: r.message };
      },
    }),

    start_assessment: tool({
      description: "Start the assessment for a job. Returns the assessment type ('oral' or 'mcq'), oral prompt or MCQ questions, the time limit in seconds (if any), and start timestamp. You should announce the assessment details, including the time limit, to the user.",
      parameters: z.object({ jobId: z.string() }),
      execute: async ({ jobId }) => store.startAssessment(account.id, jobId),
    }),

    cancel_assessment: tool({
      description:
        "Cancel the worker's running assessment for a job. IRREVERSIBLE: a cancelled assessment locks them out of ever applying to that job again. Before calling, warn them of exactly that and get an explicit spoken yes. This is one of the few actions allowed during assessment lockdown.",
      parameters: z.object({ jobId: z.string() }),
      execute: async ({ jobId }) => {
        const job = await store.getJob(jobId);
        if (!job) return { ok: false, message: "No job with that id." };
        const app = await store.cancelAssessment(account.id, jobId);
        if (!app) return { ok: false, message: "No application on that job to cancel." };
        return { ok: true, gig: job.title, message: "Assessment cancelled. The worker can no longer apply to this job." };
      },
    }),

    log_out: tool({
      description:
        "Sign the user out of this device when they ask to log out or sign out. Confirm aloud first. The browser clears the session right after this returns — tell them they are signed out and that the page will start fresh.",
      parameters: z.object({}),
      execute: async () => ({ ok: true, loggedOut: true, message: "The browser will clear the session now." }),
    }),

    assessment_time_left: tool({
      description:
        "How much time is left on the user's running, time-limited assessment. Call this when they ask how much time they have; report the remaining time honestly, then return to the current question.",
      parameters: z.object({ jobId: z.string() }),
      execute: async ({ jobId }) => {
        const t = await store.timeRemaining(account.id, jobId);
        if (!t) return { ok: false, message: "This assessment has no time limit, or it hasn't been started." };
        return { ok: true, remainingSeconds: t.remaining, limitSeconds: t.limit };
      },
    }),

    submit_assessment: tool({
      description: "Submit the worker's answer(s) to the assessment. For oral assessments, pass 'answer' as the spoken text. For MCQ assessments, pass 'answers' as an array of 0-based option indices corresponding to the user's choice for each question.",
      parameters: z.object({
        jobId: z.string(),
        answer: z.string().optional().describe("the worker's spoken answer (for oral assessments)"),
        answers: z.array(z.number()).optional().describe("the chosen option indices, 0-based (for MCQ assessments)"),
      }),
      execute: async ({ jobId, answer, answers }) => {
        if (answers !== undefined) {
          return { ok: true, ...(await store.gradeMcqAssessment(account.id, jobId, answers)) };
        }
        if (answer !== undefined) {
          return { ok: true, ...(await store.gradeOralAssessment(account.id, jobId, answer)) };
        }
        return { ok: false, message: "Either 'answer' or 'answers' must be provided." };
      },
    }),

    get_balance: tool({
      description: "Get this user's own wallet balance (real, from the live API) in Naira, with their dedicated account number for receiving money.",
      parameters: z.object({}),
      execute: async () => {
        const { balance, account: acctNo, bankName } = await store.getBalance(account.id);
        return { balance, currency: "NGN", account: acctNo, bank: bankName };
      },
    }),

    register_payout_account: tool({
      description:
        "Validate and save this user's bank account for withdrawals. Read the returned account name back to the user for spoken confirmation before withdrawing.",
      parameters: z.object({ accountNumber: z.string(), bankCode: z.string().describe("Bank code exactly as returned by listBanks — the codes differ per provider, so never type one from memory") }),
      execute: async ({ accountNumber, bankCode }) => registerPayout(account.id, accountNumber, bankCode),
    }),

    set_security_phrase: tool({
      description:
        "Set the worker's spoken security phrase — the accessible replacement for SMS codes. It confirms every withdrawal, so treat it like a PIN: collect a short memorable phrase of at least two words, read it back once for confirmation, then call this. Never suggest a phrase yourself and never repeat it in later conversation.",
      parameters: z.object({ phrase: z.string().describe("the phrase exactly as the user said it") }),
      execute: async ({ phrase }) => {
        if (account.role !== "worker") return { ok: false, message: "Only worker accounts use a spoken security phrase." };
        return store.setSecurityPhrase(account.id, phrase);
      },
    }),

    list_banks: tool({
      description:
        "The banks a withdrawal can be sent to, with the codes THIS provider accepts. Call this before registering a payout or saving a beneficiary for a bank whose code you do not already have from a previous call in this conversation. Never type a bank code from memory: the codes are provider-specific (Wema is 035 on one rail and 000017 on another) and a wrong one fails name enquiry in a way that looks like a wrong account number.",
      parameters: z.object({
        search: z.string().optional().describe("Filter by name, e.g. 'wema'. Omit to list all — there can be hundreds."),
      }),
      execute: async ({ search }) => {
        const { paymentProvider } = await import("../banking");
        try {
          const all = await paymentProvider().listBanks(account.id);
          const q = search?.trim().toLowerCase();
          const banks = q ? all.filter((b) => b.name.toLowerCase().includes(q)) : all;
          // Capped: the full BMONI list is 302 banks, and the whole thing goes
          // into the model's context on every subsequent turn.
          return { ok: true, banks: banks.slice(0, 25), total: banks.length };
        } catch (e) {
          return { ok: false, message: `I could not load the list of banks just now. ${(e as Error).message}` };
        }
      },
    }),

    list_beneficiaries: tool({
      description: "List this user's saved withdrawal beneficiaries (name, account number, bank). Use when they ask who they can send to, or to disambiguate a destination.",
      parameters: z.object({}),
      execute: async () => ({ ok: true, beneficiaries: await store.listBeneficiaries(account.id) }),
    }),

    save_beneficiary: tool({
      description:
        "Save a withdrawal destination as a beneficiary so future withdrawals can go to it by name. Call after the user says yes to saving — typically right after a successful withdrawal to a new account (pass the accountName from that result), or with details they dictate (the account is then re-verified).",
      parameters: z.object({
        accountNumber: z.string(),
        bankCode: z.string().describe("Bank code exactly as returned by listBanks"),
        accountName: z.string().optional().describe("verified account name, if known from a preceding withdrawal"),
      }),
      execute: async ({ accountNumber, bankCode, accountName }) => {
        let name = accountName;
        if (!name) {
          try {
            const { paymentProvider } = await import("../banking");
            const v = await paymentProvider().verifyDestination(account.id, accountNumber, bankCode);
            if (!v.nameVerified) {
              // Saving a fabricated name would launder it: next time it is
              // recalled from our own database and looks like something the
              // user once confirmed.
              return {
                ok: false,
                message:
                  "I could not confirm the account holder's name on this connection, so I will not save it under a name I cannot vouch for. Tell me the name to save it as and I will use that.",
              };
            }
            name = v.accountName;
          } catch {
            return { ok: false, message: "Bank details not found — check the account number and bank." };
          }
        }
        const r = await store.saveBeneficiary(account.id, { accountName: name, accountNumber, bankCode });
        return { ok: true, saved: r.created, accountName: name, message: r.created ? "Saved as a beneficiary." : "That account was already saved." };
      },
    }),

    prepare_withdrawal: tool({
      description:
        "Step 1 of 2 for a withdrawal from this user's own wallet. The destination can be: a new account (pass accountNumber + bankCode), a saved beneficiary (pass beneficiaryName), or omitted to use their only/last saved destination. Fails if the amount exceeds the wallet balance. Do NOT move money here. After calling, read back the amount followed by the returned `destination` string VERBATIM — it already says the right thing about whether the account holder's name could be confirmed. When `nameVerified` is false the name is NOT trustworthy and you must never say it, in any form; `destination` reads the digits back instead. Then: if mode is 'passphrase' (workers), tell them to say THEIR OWN security phrase to confirm — never say or guess it. If mode is 'word' (employers), give them the returned `phrase` word to say.",
      parameters: z.object({
        amount: z.number().describe("amount in Naira to withdraw"),
        accountNumber: z.string().optional().describe("destination account number, for a new destination"),
        bankCode: z.string().optional().describe("Bank code for the destination, exactly as returned by listBanks"),
        beneficiaryName: z.string().optional().describe("name of a saved beneficiary to send to"),
      }),
      execute: async ({ amount, accountNumber, bankCode, beneficiaryName }) =>
        store.armWithdrawal(account.id, amount, { accountNumber, bankCode, beneficiaryName }),
    }),

    confirm_withdrawal: tool({
      description:
        "Step 2 of 2 for a withdrawal. Pass exactly what the user said when asked to confirm. Only call this after the user has spoken; never invent the phrase. On success, if the result contains offerSaveBeneficiary, ask whether to save that account as a beneficiary and call save_beneficiary if they say yes.",
      parameters: z.object({ spokenPhrase: z.string().describe("the exact words the user just spoke to confirm") }),
      execute: async ({ spokenPhrase }) => confirmWithdrawal(account.id, spokenPhrase),
    }),

    update_profile: tool({
      description:
        "Update the worker's profile by voice. You can update their name, email, skills (an array of self-declared skills), or bio (their experience/resume summary). Speak back the updated details to confirm.",
      parameters: z.object({
        name: z.string().optional().describe("the worker's updated full name"),
        email: z.string().optional().describe("the worker's updated email"),
        skills: z.array(z.string()).optional().describe("updated list of self-declared skills"),
        bio: z.string().optional().describe("updated resume/bio description"),
      }),
      execute: async (input) => {
        const result = await store.updateProfile(account.id, input);
        const acc = result.account;
        return { ok: true, name: acc?.name, skills: acc?.skills, bio: acc?.bio };
      },
    }),

    remember_preference: tool({
      description:
        "Remember one thing about this user permanently. Use it whenever they ask you to remember something, or state a standing preference in passing — 'I can only work mornings', 'don't offer me phone support', 'read amounts back slowly'. The conversation itself is never saved, so this is the ONLY way anything survives until next time: if it is worth knowing tomorrow, it has to go here. Save one short fact in their own words, and say briefly that you'll remember it.",
      parameters: z.object({
        text: z.string().describe("the preference as one short sentence, in the user's own words"),
      }),
      execute: async ({ text }) => {
        const r = await store.addPreference(account.id, text);
        if (!r.ok) return { ok: false, message: r.message };
        return {
          ok: true,
          saved: r.added,
          preferences: r.preferences,
          message: r.added ? "Saved — I'll remember that." : "That was already remembered.",
        };
      },
    }),

    forget_preference: tool({
      description:
        "Delete something the user previously asked you to remember, when they say to forget it or that it no longer applies. Pass roughly what they said — the match is loose. Confirm aloud what was forgotten.",
      parameters: z.object({ text: z.string().describe("the preference to forget, as the user described it") }),
      execute: async ({ text }) => {
        const r = await store.removePreference(account.id, text);
        if (!r.ok) return { ok: false, message: r.message };
        return { ok: true, forgotten: r.removed, preferences: r.preferences };
      },
    }),

    read_messages: tool({
      description:
        "Read aloud the onboarding message thread for a hired gig. This channel opens only after the worker is hired. For a worker it is their onboarding conversation with the employer; for an employer it is the channel with the worker they hired. Pass the jobId — for workers, the jobId of a hired application (get_applications); for employers, a gig they hired on (review_applicants). Read each message with who sent it.",
      parameters: z.object({ jobId: z.string() }),
      execute: async ({ jobId }) => {
        const job = await store.getJob(jobId);
        if (!job) return { ok: false, message: "No job with that id." };
        // Being a worker is not the same as being THIS gig's worker. The old
        // check let any worker read any thread, and these threads are where
        // employers are told to send credentials.
        if (!(await store.partyToThread(account, jobId))) {
          return { ok: false, message: "That conversation is not yours." };
        }
        if (!(await store.messagingUnlocked(jobId))) {
          return { ok: false, message: "Messaging opens once the worker is hired for this gig." };
        }
        const messages = (await store.listMessages(jobId)).map((m) => ({ messageId: m.id, from: m.from, author: m.authorName, text: m.text }));
        return { ok: true, jobId, gig: job.title, messages };
      },
    }),

    send_message: tool({
      description:
        "Send a message in a hired gig's onboarding channel, entirely by voice. Employers use this to send onboarding directives, credentials, or next steps to the worker they hired; workers use it to reply or ask a question. Only works after the worker is hired. Always read the exact message back and get a spoken yes before sending — especially anything sensitive like credentials or account details. Pass the jobId (get_applications for workers, review_applicants for employers) and the message text as dictated.",
      parameters: z.object({
        jobId: z.string(),
        text: z.string().describe("the message to send, exactly as the user dictated it"),
      }),
      execute: async ({ jobId, text }) => {
        const job = await store.getJob(jobId);
        if (!job) return { ok: false, message: "No job with that id." };
        // Being a worker is not the same as being THIS gig's worker. The old
        // check let any worker read any thread, and these threads are where
        // employers are told to send credentials.
        if (!(await store.partyToThread(account, jobId))) {
          return { ok: false, message: "That conversation is not yours." };
        }
        if (!(await store.messagingUnlocked(jobId))) {
          return { ok: false, message: "Messaging opens once the worker is hired for this gig." };
        }
        if (!text.trim()) return { ok: false, message: "There is no message to send." };
        const from = account.role === "employer" ? ("employer" as const) : ("worker" as const);
        await store.sendMessage(jobId, from, account.id, account.name, text);
        return { ok: true, jobId, gig: job.title, sent: text.trim() };
      },
    }),
  };
}
