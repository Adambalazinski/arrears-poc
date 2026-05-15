import { z } from 'zod';

export const ApproveSchema = z.object({
  editedBodyMarkdown: z.string().min(1).optional(),
});
export type ApproveDto = z.infer<typeof ApproveSchema>;

export const RejectSchema = z.object({
  reason: z.string().min(1).max(500),
});
export type RejectDto = z.infer<typeof RejectSchema>;
