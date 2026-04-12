import { useEffect, useState } from "react";

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
}

interface InterloopSettingsProps {
  mode: "onboarding" | "settings";
  initialValues: InterloopSettingsValues;
  onSave: (values: InterloopSettingsValues) => void;
  onClose: () => void;
}

export function InterloopSettings({
  mode,
  initialValues,
  onSave,
  onClose,
}: InterloopSettingsProps) {
  const [form, setForm] = useState<InterloopSettingsValues>(initialValues);

  useEffect(() => {
    setForm(initialValues);
  }, [initialValues]);

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

  const handleSave = () => {
    onSave({
      ...form,
      completed: true,
    });
  };

  return (
    <div className="fixed inset-0 z-50 bg-black text-white overflow-y-auto">
      <div
        className="w-full px-6 pt-6 pb-24"
        style={{
          paddingTop: "max(env(safe-area-inset-top) + 1.5rem, 2rem)",
          paddingBottom: "max(env(safe-area-inset-bottom) + 5rem, 6rem)",
        }}
      >
        <div className="w-full max-w-xl mx-auto rounded-2xl border border-[#1f1f1f] bg-[#0b0b0b] p-6 sm:p-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-medium">Interloop Setup</h1>
              <p className="mt-2 text-sm text-gray-400">
                {isOnboarding
                  ? "Complete these fields before entering the app."
                  : "Update your local Interloop settings."}
              </p>
            </div>

            {!isOnboarding && (
              <button
                onClick={onClose}
                className="text-sm text-gray-400 hover:text-white"
              >
                Close
              </button>
            )}
          </div>

          <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-2">
              <span className="text-sm text-gray-300">Name</span>
              <input
                value={form.name}
                onChange={(e) => updateField("name", e.target.value)}
                className="rounded-lg border border-[#2a2a2a] bg-black px-3 py-3 text-white outline-none"
              />
            </label>

            <label className="flex flex-col gap-2">
              <span className="text-sm text-gray-300">Age</span>
              <input
                value={form.age}
                onChange={(e) => updateField("age", e.target.value)}
                className="rounded-lg border border-[#2a2a2a] bg-black px-3 py-3 text-white outline-none"
              />
            </label>

            <label className="flex flex-col gap-2">
              <span className="text-sm text-gray-300">Height</span>
              <input
                value={form.height}
                onChange={(e) => updateField("height", e.target.value)}
                className="rounded-lg border border-[#2a2a2a] bg-black px-3 py-3 text-white outline-none"
              />
            </label>

            <label className="flex flex-col gap-2">
              <span className="text-sm text-gray-300">Weight</span>
              <input
                value={form.weight}
                onChange={(e) => updateField("weight", e.target.value)}
                className="rounded-lg border border-[#2a2a2a] bg-black px-3 py-3 text-white outline-none"
              />
            </label>

            <label className="flex flex-col gap-2 sm:col-span-2">
              <span className="text-sm text-gray-300">
                Primary activity / sport
              </span>
              <input
                value={form.primaryActivity}
                onChange={(e) => updateField("primaryActivity", e.target.value)}
                className="rounded-lg border border-[#2a2a2a] bg-black px-3 py-3 text-white outline-none"
              />
            </label>

            <label className="flex flex-col gap-2">
              <span className="text-sm text-gray-300">Dominant hand</span>
              <select
                value={form.dominantHand}
                onChange={(e) => updateField("dominantHand", e.target.value)}
                className="rounded-lg border border-[#2a2a2a] bg-black px-3 py-3 text-white outline-none"
              >
                <option value="">Select</option>
                <option value="right">Right</option>
                <option value="left">Left</option>
                <option value="ambidextrous">Ambidextrous</option>
              </select>
            </label>

            <label className="flex flex-col gap-2">
              <span className="text-sm text-gray-300">Activity level</span>
              <select
                value={form.activityLevel}
                onChange={(e) => updateField("activityLevel", e.target.value)}
                className="rounded-lg border border-[#2a2a2a] bg-black px-3 py-3 text-white outline-none"
              >
                <option value="">Select</option>
                <option value="low">Low</option>
                <option value="moderate">Moderate</option>
                <option value="high">High</option>
                <option value="very_high">Very high</option>
              </select>
            </label>

            <label className="flex flex-col gap-2">
              <span className="text-sm text-gray-300">Competition level</span>
              <select
                value={form.competitionLevel}
                onChange={(e) =>
                  updateField("competitionLevel", e.target.value)
                }
                className="rounded-lg border border-[#2a2a2a] bg-black px-3 py-3 text-white outline-none"
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

            <label className="flex flex-col gap-2">
              <span className="text-sm text-gray-300">Voice</span>
              <select
                value={form.voice}
                onChange={(e) =>
                  updateField("voice", e.target.value as InterloopVoiceOption)
                }
                className="rounded-lg border border-[#2a2a2a] bg-black px-3 py-3 text-white outline-none"
              >
                <option value="female_yoga">female_yoga</option>
                <option value="female_pilates">female_pilates</option>
                <option value="male_coach">male_coach</option>
                <option value="male_pt">male_pt</option>
              </select>
            </label>
          </div>

          <div className="mt-10 flex items-center justify-end gap-3">
            {!isOnboarding && (
              <button
                onClick={onClose}
                className="rounded-lg border border-[#2a2a2a] px-4 py-2 text-sm text-gray-300"
              >
                Cancel
              </button>
            )}

            <button
              onClick={handleSave}
              className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
