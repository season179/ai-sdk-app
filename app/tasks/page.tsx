import type { Metadata } from "next";

import { ScheduledJobsBoard } from "@/components/scheduled-jobs-board";

export const metadata: Metadata = {
  title: "Scheduled tasks",
};

export default function TasksPage() {
  return <ScheduledJobsBoard />;
}
