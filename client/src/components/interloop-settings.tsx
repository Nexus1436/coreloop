import { useEffect, useRef, useState } from "react";

export type InterloopVoiceOption =
  | "female_yoga"
  | "female_pilates"
  | "male_coach"
  | "male_pt";

export interface InterloopSettingsValues {
  name: string;
  age: string;
  height: string;
  weight: string;
  primaryActivity: string;
  dominantHand: string;
  activityLevel: string;
  competitionLevel: string;
  voice: InterloopVoiceOption;
  completed: boolean;
  profileImageUrl?: string;
}

interface InterloopSettingsProps {
  mode: "onboarding" | "settings";
  initialValues: InterloopSettingsValues;
  onSave: (values: InterloopSettingsValues) => void;
  onClose: () => void;
}

const VOICE_OPTIONS = [
  {
    key: "male_coach",
    label: "Ethan",
    image: "/voice-avatars/male_coach.png",
    preview: "/voice-previews/ethan_preview.mp3",
  },
  {
    key: "male_pt",
    label: "Marcus",
    image: "/voice-avatars/male_pt.png",
    preview: "/voice-previews/marcus_preview.mp3",
  },
  {
    key: "female_pilates",
    label: "Sofia",
    image: "/voice-avatars/female_pilates.png",
    preview: "/voice-previews/sofia_preview.mp3",
  },
  {
    key: "female_yoga",
    label: "Aria",
    image: "/voice-avatars/female_yoga.png",
    preview: "/voice-previews/aria_preview.mp3",
  },
] as const;

export function InterloopSettings({
  mode,
  initialValues,
  onSave,
  onClose,
}: InterloopSettingsProps) {
  const [form, setForm] = useState<InterloopSettingsValues>(initialValues);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setForm(initialValues);
  }, [initialValues]);

  useEffect(() => {
    return () => {
      if (previewAudioRef.current) {
        previewAudioRef.current.pause();
        previewAudioRef.current.currentTime = 0;
      }
    };
  }, []);

  const isOnboarding = mode === "onboarding";

  const updateField = <K extends keyof InterloopSettingsValues>(
    key: K,
    value: InterloopSettingsValues[K],
  ) => {
    setForm((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  const playVoicePreview = (preview: string) => {
    console.log("Playing:", preview);

    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current.currentTime = 0;
    }

    const audio = new Audio(preview);
    previewAudioRef.current = audio;

    audio.play().catch((err) => {
      console.error("Voice preview failed:", err);
    });
  };

  const handleVoiceSelect = (voice: InterloopVoiceOption, preview: string) => {
    updateField("voice", voice);
    playVoicePreview(preview);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;

    try {
      const formData = new FormData();
      formData.append("file", file);

      const resp = await fetch("/api/upload-profile-image", {
        method: "POST",
        body: formData,
        credentials: "include",
      });

      if (!resp.ok) {
        console.error("Profile image upload failed:", resp.status);
        return;
      }

      const data = await resp.json().catch(() => null);
      const uploadedUrl =
        data && typeof data.url === "string" && data.url.trim()
          ? data.url.trim()
          : null;

      if (!uploadedUrl) {
        console.error("Profile image upload: no URL returned");
        return;
      }

      // Immediately push the durable backend URL into live form state
      // so the avatar bubble can render the new image right away,
      // without waiting for a full save cycle or a settings refetch.
      setForm((prev) => ({
        ...prev,
        profileImageUrl: uploadedUrl,
      }));
    } catch (err) {
      console.error("Profile image upload error:", err);
    } finally {
      // Reset the input so selecting the same file again still fires onChange.
      if (input) {
        input.value = "";
      }
    }
  };

  const handleSave = () => {
    onSave({
      ...form,
      completed: true,
      profileImageUrl: form.profileImageUrl,
    });
  };

  const inputClassName =
    "rounded-xl border border-[#4a3420] bg-[#050403] px-3 py-3 text-[#fff7eb] outline-none shadow-[0_0_0_1px_rgba(255,178,87,0.03),0_0_22px_rgba(255,154,61,0.04)] transition placeholder:text-[#6d6258] focus:border-[#f7a43b] focus:shadow-[0_0_0_1px_rgba(247,164,59,0.25),0_0_24px_rgba(247,164,59,0.14)]";

  const labelClassName = "text-sm font-medium text-[#d4ad7a]";

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[#030201] text-[#fff7eb]">
      <div
        className="w-full px-5 pt-6 pb-24 sm:px-6"
        style={{
          paddingTop: "max(env(safe-area-inset-top) + 1.5rem, 2rem)",
          paddingBottom: "max(env(safe-area-inset-bottom) + 5rem, 6rem)",
        }}
      >
        <div className="mx-auto w-full max-w-xl rounded-2xl border border-[#7a4a22]/60 bg-[#080604] p-6 shadow-[0_0_0_1px_rgba(255,178,87,0.06),0_0_44px_rgba(255,145,38,0.18),inset_0_1px_0_rgba(255,213,158,0.08)] sm:p-8">
          <input
            type="file"
            accept="image/png, image/jpeg"
            ref={fileInputRef}
            style={{ display: "none" }}
            onChange={handleFileChange}
          />

          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-medium tracking-[0.01em] text-[#ffc46f] drop-shadow-[0_0_18px_rgba(255,169,67,0.28)]">
                Your Setup
              </h1>
              <p className="mt-2 text-sm text-[#9f8a70]">
                {isOnboarding
                  ? "Complete these fields before entering the app."
                  : "Update your setup."}
              </p>
            </div>

            {!isOnboarding && (
              <button
                onClick={onClose}
                className="rounded-full border border-[#4a3420] px-4 py-2 text-sm text-[#d4ad7a] transition hover:border-[#f7a43b]/70 hover:text-[#ffc46f] hover:shadow-[0_0_18px_rgba(247,164,59,0.12)]"
              >
                Close
              </button>
            )}
          </div>

          <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-2">
              <span className={labelClassName}>Name</span>
              <input
                value={form.name}
                onChange={(e) => updateField("name", e.target.value)}
                className={inputClassName}
              />
            </label>

            <label className="flex flex-col gap-2">
              <span className={labelClassName}>Age</span>
              <input
                value={form.age}
                onChange={(e) => updateField("age", e.target.value)}
                className={inputClassName}
              />
            </label>

            <label className="flex flex-col gap-2">
              <span className={labelClassName}>Height</span>
              <input
                value={form.height}
                onChange={(e) => updateField("height", e.target.value)}
                className={inputClassName}
              />
            </label>

            <label className="flex flex-col gap-2">
              <span className={labelClassName}>Weight</span>
              <input
                value={form.weight}
                onChange={(e) => updateField("weight", e.target.value)}
                className={inputClassName}
              />
            </label>

            <div className="flex flex-col gap-2 sm:col-span-2">
              <span className={labelClassName}>Profile photo</span>
              <div className="flex items-center gap-4">
                <span
                  className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[#6b4525]/80 bg-[#120b05] shadow-[0_0_16px_rgba(255,157,54,0.08)]"
                  aria-hidden="true"
                >
                  {form.profileImageUrl ? (
                    <img
                      src={form.profileImageUrl}
                      alt="Profile preview"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-7 w-7 text-[#6b4525]"
                    >
                      <circle cx="12" cy="8" r="4" />
                      <path d="M4 21c0-4 4-7 8-7s8 3 8 7" />
                    </svg>
                  )}
                </span>

                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-fit rounded-full border border-[#4a3420] px-5 py-2.5 text-sm font-medium text-[#d4ad7a] transition hover:border-[#f7a43b]/70 hover:text-[#ffc46f] hover:shadow-[0_0_18px_rgba(247,164,59,0.12)]"
                >
                  Upload Photo
                </button>
              </div>
            </div>

            <label className="flex flex-col gap-2 sm:col-span-2">
              <span className={labelClassName}>Primary activity / sport</span>
              <input
                value={form.primaryActivity}
                onChange={(e) => updateField("primaryActivity", e.target.value)}
                className={inputClassName}
              />
            </label>

            <label className="flex flex-col gap-2">
              <span className={labelClassName}>Dominant hand</span>
              <select
                value={form.dominantHand}
                onChange={(e) => updateField("dominantHand", e.target.value)}
                className={inputClassName}
              >
                <option value="">Select</option>
                <option value="right">Right</option>
                <option value="left">Left</option>
                <option value="ambidextrous">Ambidextrous</option>
              </select>
            </label>

            <label className="flex flex-col gap-2">
              <span className={labelClassName}>Activity level</span>
              <select
                value={form.activityLevel}
                onChange={(e) => updateField("activityLevel", e.target.value)}
                className={inputClassName}
              >
                <option value="">Select</option>
                <option value="low">Low</option>
                <option value="moderate">Moderate</option>
                <option value="high">High</option>
                <option value="very_high">Very high</option>
              </select>
            </label>

            <label className="flex flex-col gap-2">
              <span className={labelClassName}>Competition level</span>
              <select
                value={form.competitionLevel}
                onChange={(e) =>
                  updateField("competitionLevel", e.target.value)
                }
                className={inputClassName}
              >
                <option value="">Select</option>
                <option value="recreational">Recreational</option>
                <option value="club">Club</option>
                <option value="amateur_competitive">Amateur competitive</option>
                <option value="high_level_competitive">
                  High-level competitive
                </option>
              </select>
            </label>

            <section className="mt-2 flex flex-col gap-4 sm:col-span-2">
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-[#ffc46f]">
                  Voice Identity
                </h2>
              </div>

              <div className="grid grid-cols-2 gap-x-5 gap-y-5">
                {VOICE_OPTIONS.map((option) => {
                  const selected = form.voice === option.key;

                  return (
                    <button
                      key={option.key}
                      type="button"
                      onClick={() =>
                        handleVoiceSelect(option.key, option.preview)
                      }
                      className={[
                        "group flex min-h-[154px] flex-col items-center justify-start rounded-2xl px-3 py-3 text-center outline-none transition duration-200",
                        selected ? "scale-[1.035]" : "hover:scale-[1.01]",
                      ].join(" ")}
                      aria-pressed={selected}
                    >
                      <span
                        className={[
                          "flex h-[110px] w-[110px] items-center justify-center rounded-full border p-1.5 transition duration-200 sm:h-32 sm:w-32",
                          selected
                            ? "border-2 border-[#ffc46f] shadow-[0_0_0_2px_rgba(255,196,111,0.32),0_0_42px_rgba(255,157,54,0.48),inset_0_0_18px_rgba(255,196,111,0.16)]"
                            : "border border-[#6b4525]/80 shadow-[0_0_16px_rgba(255,157,54,0.08)] group-hover:border-[#b87837] group-hover:shadow-[0_0_24px_rgba(255,157,54,0.14)]",
                        ].join(" ")}
                      >
                        <span className="block h-full w-full overflow-hidden rounded-full bg-[#120b05]">
                          <img
                            src={option.image}
                            alt={option.label}
                            className="h-full w-full object-cover"
                          />
                        </span>
                      </span>

                      <span
                        className={[
                          "mt-3 text-sm transition duration-200",
                          selected
                            ? "font-bold text-[#ffe0a3] drop-shadow-[0_0_14px_rgba(255,190,102,0.38)]"
                            : "font-semibold text-[#c19a68] group-hover:text-[#ffd18a]",
                        ].join(" ")}
                      >
                        {option.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          </div>

          <div className="mt-10 flex items-center justify-end gap-3">
            {!isOnboarding && (
              <button
                onClick={onClose}
                className="rounded-full border border-[#4a3420] px-5 py-2.5 text-sm font-medium text-[#d4ad7a] transition hover:border-[#f7a43b]/70 hover:text-[#ffc46f] hover:shadow-[0_0_18px_rgba(247,164,59,0.12)]"
              >
                Cancel
              </button>
            )}

            <button
              onClick={handleSave}
              className="rounded-full border border-[#ffc46f]/60 bg-[#f7a43b] px-5 py-2.5 text-sm font-semibold text-[#160b02] shadow-[0_0_24px_rgba(247,164,59,0.28),inset_0_1px_0_rgba(255,255,255,0.28)] transition hover:bg-[#ffb85b] hover:shadow-[0_0_30px_rgba(247,164,59,0.38),inset_0_1px_0_rgba(255,255,255,0.34)]"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
