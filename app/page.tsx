"use client";

import { useChatShell } from "@/components/chat/chat-shell-context";
import { ChatSurface } from "@/components/chat/chat-surface";
import { TokenUsageMenu } from "@/components/chat/token-usage-menu";
import { SiteHeader, SiteHeaderStatus } from "@/components/site-header";

export default function ChatPage() {
  const { active, chatBusy, usage, setBusy, setUsage, reportConversationUpdated } = useChatShell();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <h1 className="sr-only">Chat</h1>
      <SiteHeader
        actions={<TokenUsageMenu {...usage} />}
        status={
          <SiteHeaderStatus pulse={chatBusy}>{chatBusy ? "Responding" : "Ready"}</SiteHeaderStatus>
        }
      />

      {active ? (
        <ChatSurface
          initialMessages={active.messages}
          key={active.id}
          onBusyChange={setBusy}
          onConversationUpdated={reportConversationUpdated}
          onUsageChange={setUsage}
          sessionId={active.id}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Loading…
        </div>
      )}
    </div>
  );
}
