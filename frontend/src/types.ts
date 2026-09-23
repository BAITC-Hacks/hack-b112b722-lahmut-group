export type Participant = {
  id: string;
  display_name: string;
  speaker_id: string | null;
};
export type Segment = {
  id: string;
  start_ms: number;
  end_ms: number;
  speaker_id: string;
  text: string;
};
export type Action = {
  id: string;
  title: string;
  assignee: string;
  due_text: string;
  due_date: string | null;
  evidence_segment_ids: string[];
  review_reasons: string[];
  status: "open" | "done";
};
export type Meeting = {
  id: string;
  title: string;
  occurred_at: string;
  timezone: string;
  source_mode: "audio" | "text" | "demo";
  status:
    | "queued"
    | "transcribing"
    | "diarizing"
    | "extracting"
    | "review_ready"
    | "failed";
  approved: boolean;
  revision: number;
  participants: Participant[];
  segments: Segment[];
  summary: string;
  actions: Action[];
  warnings: string[];
  error: string | null;
  created_at: string;
  has_audio: boolean;
};
export type Notification = {
  id: string;
  meeting_id: string;
  action_id: string;
  title: string;
  kind: "due_soon" | "overdue";
  assignee: string;
};
export type Health = {
  status: string;
  mode: string;
  providers: { speech: boolean; llm: boolean; diarization: boolean };
  details: Record<string, unknown>;
};

export type Draft = {
  revision: number;
  summary: string;
  actions: Action[];
  participants: Participant[];
};
export type Task = Action & {
  meeting_id: string;
  meeting_title: string;
  approved: boolean;
  overdue: boolean;
};
