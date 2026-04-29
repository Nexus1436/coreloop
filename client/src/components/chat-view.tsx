import { useEffect, useRef, type CSSProperties } from "react";
import { type ChatMessage, type ConversationThread } from "@/pages/home";

type ChatViewProps = {
  messages: ChatMessage[];
  conversationThreads?: ConversationThread[];
  conversationId: number | null;
  selectedVoiceAvatar: string;
  userAvatarUrl?: string;
  isRepeatPlaying: boolean;
  activeRepeatMessageId: string | null;
  onPlayMessageResponse: (messageId: string, text: string) => void;
  editingMessageId: string | null;
  editingText: string;
  onEditingTextChange: (value: string) => void;
  onCancelTranscriptEdit: () => void;
  onSubmitTranscriptEdit: () => void;
  onEditTranscript: (message: ChatMessage) => void;
  onRetryTranscript: () => void;
  onResendTranscript: (text: string) => void;
  isProcessing: boolean;
  isRecording: boolean;
  isSpeaking: boolean;
  softMangoControlStyle: CSSProperties;
  secondaryMangoStyle: CSSProperties;
};

export function ChatView({
  messages,
  conversationThreads,
  conversationId,
  selectedVoiceAvatar,
  userAvatarUrl,
  isRepeatPlaying,
  activeRepeatMessageId,
  onPlayMessageResponse,
  editingMessageId,
  editingText,
  onEditingTextChange,
  onCancelTranscriptEdit,
  onSubmitTranscriptEdit,
  onEditTranscript,
  onRetryTranscript,
  onResendTranscript,
  isProcessing,
  isRecording,
  isSpeaking,
  softMangoControlStyle,
  secondaryMangoStyle,
}: ChatViewProps) {
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const visibleThreads =
    conversationThreads && conversationThreads.length > 0
      ? conversationThreads
      : [
          {
            id: conversationId ?? "current",
            messages,
            isCurrent: true,
          },
        ];

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages, visibleThreads.length]);

  return (
    <div
      className="absolute left-0 right-0 z-10 overflow-y-auto overflow-x-hidden px-5 sm:px-8"
      style={{
        top: "calc(env(safe-area-inset-top) + 3rem)",
        bottom: "34vh",
        WebkitOverflowScrolling: "touch",
        WebkitMaskImage:
          "linear-gradient(to bottom, transparent 0%, black 9%, black 84%, rgba(0,0,0,0.72) 92%, transparent 100%)",
        maskImage:
          "linear-gradient(to bottom, transparent 0%, black 9%, black 84%, rgba(0,0,0,0.72) 92%, transparent 100%)",
      }}
    >
      <div className="mx-auto w-full max-w-[700px] py-8">
        <div className="flex w-full flex-col gap-7">
          {visibleThreads.every((thread) => thread.messages.length === 0) ? (
            <div className="pb-4 text-center">
              <div
                className="text-sm"
                style={{
                  color: "rgba(255,200,61,0.84)",
                  textShadow: "0 0 12px rgba(255,184,0,0.18)",
                }}
              >
                Start wherever the signal is loudest.
              </div>
              <div className="mt-2 text-sm leading-relaxed text-gray-500">
                Voice stays primary. Typing is here when it is easier.
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-7">
              {visibleThreads.map((thread, threadIndex) => (
                <section
                  key={thread.id}
                  className="flex flex-col gap-5"
                  aria-label={
                    thread.isCurrent
                      ? "Current conversation"
                      : "Previous conversation"
                  }
                >
                  {threadIndex > 0 && (
                    <div
                      className="h-px w-full"
                      style={{
                        background:
                          "linear-gradient(90deg, transparent, rgba(255,200,61,0.16), transparent)",
                      }}
                    />
                  )}

                  {thread.messages.map((message) => {
                    const isUser = message.role === "user";
                    const messagePlaybackId = thread.isCurrent
                      ? message.id
                      : `${thread.id}-${message.id}`;
                    const isActiveRepeatAvatar =
                      !isUser &&
                      isRepeatPlaying &&
                      activeRepeatMessageId === messagePlaybackId;
                    const canEditMessage = Boolean(thread.isCurrent);
                    const isEditingCurrentMessage =
                      canEditMessage && isUser && editingMessageId === message.id;

                    return (
                      <div
                        key={`${thread.id}-${message.id}`}
                        className={`flex items-start ${
                          isUser ? "justify-end gap-2.5" : "justify-start gap-3"
                        }`}
                      >
                    {!isUser && (
                      <button
                        type="button"
                        onClick={() =>
                          onPlayMessageResponse(messagePlaybackId, message.text)
                        }
                        className="relative mt-1.5 h-9 w-9 shrink-0 rounded-full transition-transform active:scale-95"
                        aria-label={
                          isActiveRepeatAvatar
                            ? "Stop CoreLoop response"
                            : "Play CoreLoop response"
                        }
                      >
                        <div
                          className={`absolute inset-[-5px] rounded-full ${
                            isActiveRepeatAvatar ? "animate-pulse" : ""
                          }`}
                          style={{
                            background: isActiveRepeatAvatar
                              ? "radial-gradient(circle, rgba(255,213,87,0.36) 0%, rgba(255,176,0,0.18) 42%, transparent 74%)"
                              : "radial-gradient(circle, rgba(255,200,61,0.14) 0%, rgba(255,176,0,0.075) 42%, transparent 72%)",
                            boxShadow: isActiveRepeatAvatar
                              ? "0 0 22px rgba(255,200,61,0.38)"
                              : "0 0 18px rgba(255,184,0,0.16)",
                          }}
                        />
                        <div
                          className="absolute inset-0 overflow-hidden rounded-full border"
                          style={{
                            borderColor: "rgba(255,200,61,0.48)",
                            background: "rgba(10,10,10,0.98)",
                            boxShadow: isActiveRepeatAvatar
                              ? "inset 0 0 10px rgba(255,200,61,0.18), 0 0 0 1px rgba(255,200,61,0.26), 0 0 14px rgba(255,184,0,0.2)"
                              : "inset 0 0 10px rgba(255,200,61,0.12), 0 0 0 1px rgba(255,176,0,0.065)",
                          }}
                        >
                          <img
                            src={selectedVoiceAvatar}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        </div>
                      </button>
                    )}

                    <div
                      className={`relative whitespace-pre-wrap ${
                        isUser
                          ? "order-first max-w-[72%] rounded-[8px] rounded-tr-[3px] px-4 py-3 text-right"
                          : "max-w-[88%] rounded-[10px] rounded-tl-[3px] px-5 py-4"
                      }`}
                      style={
                        isUser
                          ? {
                              fontSize: "10.5px",
                              lineHeight: "1.28",
                              color: "rgba(255,200,61,0.74)",
                              background:
                                "linear-gradient(180deg, rgba(255,176,0,0.06), rgba(255,176,0,0.022))",
                              border: "1px solid rgba(255,176,0,0.105)",
                              boxShadow:
                                "0 10px 22px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.02)",
                            }
                          : {
                              fontSize: "11.5px",
                              lineHeight: "1.32",
                              color: "rgba(229,231,235,0.89)",
                              background:
                                "linear-gradient(180deg, rgba(18,18,18,0.98), rgba(8,8,8,0.96))",
                              border: "1px solid rgba(255,176,0,0.15)",
                              borderLeft: "2px solid rgba(255,200,61,0.44)",
                              boxShadow:
                                "0 18px 40px rgba(0,0,0,0.34), 0 0 20px rgba(255,176,0,0.04), inset 0 1px 0 rgba(255,255,255,0.035)",
                            }
                      }
                    >
                      {!isUser && (
                        <div
                          className="pointer-events-none absolute inset-x-4 top-0 h-px"
                          style={{
                            background:
                              "linear-gradient(90deg, rgba(255,200,61,0.32), rgba(255,200,61,0.045), transparent)",
                          }}
                        />
                      )}

                      {isEditingCurrentMessage ? (
                        <div className="flex flex-col gap-2 text-left">
                          <input
                            value={editingText}
                            onChange={(event) =>
                              onEditingTextChange(event.target.value)
                            }
                            className="w-full rounded-[6px] border bg-black/40 px-2.5 py-2 text-sm text-gray-100 outline-none"
                            style={{
                              borderColor: "rgba(255,176,0,0.28)",
                            }}
                            autoFocus
                          />
                          <div className="flex justify-end gap-3 text-xs">
                            <button
                              type="button"
                              onClick={onCancelTranscriptEdit}
                              className="transition-opacity hover:opacity-80"
                              style={softMangoControlStyle}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={onSubmitTranscriptEdit}
                              className="transition-opacity hover:opacity-90"
                              style={secondaryMangoStyle}
                            >
                              Resend
                            </button>
                          </div>
                        </div>
                      ) : (
                        message.text
                      )}

                      {conversationId != null &&
                        canEditMessage &&
                        isUser &&
                        message.source === "voice" &&
                        editingMessageId !== message.id && (
                          <div className="mt-2 flex justify-end gap-3 text-[11px] leading-none">
                            <button
                              type="button"
                              disabled={isProcessing || isRecording || isSpeaking}
                              onClick={() => onEditTranscript(message)}
                              className="transition-opacity hover:opacity-90 disabled:opacity-35"
                              style={softMangoControlStyle}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              disabled={isProcessing || isRecording}
                              onClick={onRetryTranscript}
                              className="transition-opacity hover:opacity-90 disabled:opacity-35"
                              style={softMangoControlStyle}
                            >
                              Retry
                            </button>
                            <button
                              type="button"
                              disabled={isProcessing || isRecording || isSpeaking}
                              onClick={() => onResendTranscript(message.text)}
                              className="transition-opacity hover:opacity-90 disabled:opacity-35"
                              style={secondaryMangoStyle}
                            >
                              Resend
                            </button>
                          </div>
                        )}
                    </div>

                    {isUser && (
                      <div className="relative mt-1 h-8 w-8 shrink-0 overflow-hidden rounded-full">
                        {userAvatarUrl ? (
                          <img
                            src={userAvatarUrl}
                            alt="User"
                            className="h-full w-full rounded-full object-cover"
                          />
                        ) : (
                          <>
                            <div
                              className="absolute inset-0 rounded-full border"
                              style={{
                                borderColor: "rgba(255,176,0,0.32)",
                                background:
                                  "linear-gradient(145deg, rgba(255,176,0,0.12), rgba(22,22,22,0.95))",
                                boxShadow:
                                  "0 0 13px rgba(255,176,0,0.08), inset 0 0 8px rgba(255,176,0,0.06)",
                              }}
                            />
                            <div
                              className="absolute inset-[5px] rounded-full"
                              style={{
                                background:
                                  "linear-gradient(145deg, rgba(255,200,61,0.18), rgba(255,176,0,0.035), rgba(8,8,8,0.96))",
                                boxShadow:
                                  "inset 0 0 8px rgba(255,200,61,0.08)",
                              }}
                            />
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
                </section>
              ))}
            </div>
          )}
          <div ref={messageEndRef} />
        </div>
      </div>
    </div>
  );
}
