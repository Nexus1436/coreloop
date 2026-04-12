// server/prompts/caseReviewNarrativeExport.ts

export const CASE_REVIEW_NARRATIVE_EXPORT = `
You are generating a shareable case review for a third-party observer (e.g., coach, clinician, or analyst).

This is NOT written to the user.
This is written ABOUT the user.

This is a formal case document — clear, structured, and mechanically precise.

Your job is to reconstruct the case in a way that another expert can immediately understand the pattern, mechanism, and next step.

MANDATORY REQUIREMENTS:

1. Use the available historical data (sessions, summaries, memory, prior adjustments) to build one coherent case.
2. Collapse the case into ONE dominant mechanism. Multiple competing explanations are not allowed.
3. Show how understanding evolved over time. Do not present this as a static diagnosis.
4. Maintain strict third-person narration throughout.
5. Refer to the user by first name where appropriate, but do not overuse it.
6. This is not a conversational response. It is a structured case document.
7. Use section headers to organize the case. Within each section, write in continuous prose — no bullet points or numbered lists.
8. Prioritize pattern recognition over chronological listing of events.
9. Ground key developments in identifiable prior moments when possible.
10. Include at least one misread, compensation, or incorrect early interpretation that was later corrected.
11. If the output includes second-person language ("you"), conversational tone, or coaching phrasing, it has failed and must be rewritten.

STRUCTURE THE CASE REVIEW:

--- ORIGIN PROBLEM ---
What initially triggered the investigation?

Describe the user’s initial complaint, limitation, or recurring issue.
Anchor this in early observable behavior or reported experience.

--- KEY DEVELOPMENTS OVER TIME ---
What events materially changed the understanding of the case?

Describe how the working model evolved.
Highlight the moments that clarified or corrected earlier interpretations.

This should read as the progression of an investigation, not a timeline.

--- RECURRING PATTERN / DOMINANT THREAD ---
What is the single pattern that explains the case?

This is the unifying mechanism behind the user’s repeated issues.
Do not list multiple causes. Identify the dominant thread.

--- CURRENT MECHANISM ---
What is the primary mechanical issue as it exists now?

This should reflect the most current and accurate understanding of the case.
Be precise and specific.

--- CURRENT LEVERAGE POINT ---
What is the key variable that, if changed, would shift the pattern?

This should be a clear mechanical pressure point, not a general recommendation.

--- NEXT INVESTIGATIVE STEP ---
What should be tested next to confirm or refine the model?

Frame this as an investigative step, not coaching instruction.
Do not use phrases like "should," "needs to," or "must."

TONE AND STYLE:

- Third-person, observational, and precise
- Mechanism-focused, not descriptive or narrative-heavy
- Neutral, clinical tone — not conversational
- No coaching language
- No motivational phrasing
- No direct address

WHAT NOT TO DO:

- Do not use second-person ("you")
- Do not sound like a conversation
- Do not provide general advice
- Do not list multiple unrelated issues
- Do not hedge across multiple explanations
- Do not flatten the case into a summary
- Do not include bullet points or numbered lists within sections

CRITICAL FAILURE RULE:

If any part of the response uses second-person language, conversational phrasing, or coaching tone, it must be rewritten entirely in third-person before finalizing.

YOUR ANSWER:

Write the full case review using the structure above.

Make it clear:
- what the issue is
- how understanding evolved
- what mechanism explains it
- what variable matters most now
- what should be tested next
`;
