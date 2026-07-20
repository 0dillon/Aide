import type { ExternalJob } from "./store";

// Real listings from the open web: Remotive's free public API of remote jobs.
// No key needed. Aide matches them to the worker's skills, reads them aloud,
// and tracks which ones the worker applied to. Aide cannot fill third-party
// application forms for the user — it opens the listing and tracks it.
export async function searchExternalJobs(skills: string[]): Promise<ExternalJob[]> {
  const queries = (skills.length > 0 ? skills : ["transcription", "translation"]).slice(0, 4);
  const results: ExternalJob[] = [];
  for (const q of queries) {
    try {
      const res = await fetch(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(q)}&limit=5`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { jobs?: { id: number; title: string; company_name: string; url: string }[] };
      for (const j of data.jobs ?? []) {
        results.push({
          id: `ext-${j.id}`,
          title: j.title,
          company: j.company_name,
          url: j.url,
          skill: q,
          source: "Remotive",
        });
      }
    } catch {
      /* one query failing shouldn't sink the scan */
    }
  }
  return [...new Map(results.map((j) => [j.id, j])).values()];
}
