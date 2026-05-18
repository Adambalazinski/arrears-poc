import { z } from 'zod';

export const ApproveSchema = z.object({
  editedBodyMarkdown: z.string().min(1).optional(),
});
export type ApproveDto = z.infer<typeof ApproveSchema>;

export const RejectSchema = z.object({
  reason: z.string().min(1).max(500),
});
export type RejectDto = z.infer<typeof RejectSchema>;

export const DismissSchema = z.object({
  note: z.string().max(500).optional(),
});
export type DismissDto = z.infer<typeof DismissSchema>;
