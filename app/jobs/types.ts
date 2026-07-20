// Shapes shared by the jobs page and its extracted components. These mirror
// the sanitized server responses (publicJob — no MCQ correctIndex).

export type Job = {
  id: string;
  title: string;
  task: string;
  skill: string;
  pay: number;
  employer: string;
  requiresAssessment: boolean;
  assessmentType?: "oral" | "mcq";
  assessmentQuestion?: string;
  mcqQuestions?: { question: string; options: string[] }[];
  timeLimit?: number;
};

export type Application = { id: string; jobId: string; status: string; verified: boolean };

export type AssessmentData = {
  job: Job;
  assessmentType: "oral" | "mcq";
  prompt?: string;
  questions?: { question: string; options: string[] }[];
  timeLimit?: number;
  startedAt?: number;
};

export type AssessmentResult = { verified: boolean; message: string };

export const naira = (n: number) => "₦" + n.toLocaleString("en-NG");
