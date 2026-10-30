import { Type, type Static } from 'typebox';
import { ContractSchema } from './units.ts';

const text = Type.String({ minLength: 1, maxLength: 6000 });
const note = Type.String({ maxLength: 6000 });
const id = Type.Integer({ minimum: 1 });
const object = <T extends Record<string, any>>(properties: T) => Type.Object(properties, { additionalProperties: false });
export const EdgeSchema = Type.Unsafe<Edge>(Type.Union([
  object({ type: Type.Literal('goals'), goal: text, constraints: note }),
  object({ type: Type.Literal('issue'), text, issueId: Type.Optional(id) }),
  object({ type: Type.Literal('critique'), text: Type.Optional(text) }),
  ...['decide', 'inspect', 'review', 'finish', 'revisitGoals'].map(type => object({ type: Type.Literal(type) })),
  ...['adopt', 'revise', 'design', 'correct', 'defer', 'accept'].map(type => object({ type: Type.Literal(type), note })),
  object({ type: Type.Literal('scope'), contract: ContractSchema }),
  object({ type: Type.Literal('start'), contract: Type.Optional(ContractSchema) }),
  object({ type: Type.Literal('switchIssue'), issueId: id }),
  object({ type: Type.Literal('switchUnit'), unitId: id }),
]));
// Explicit discriminated type keeps the reducer exhaustive even though TypeBox's mapped literals widen.
export type Edge =
  | { type: 'goals'; goal: string; constraints: string }
  | { type: 'issue'; text: string; issueId?: number }
  | { type: 'critique'; text?: string }
  | { type: 'decide' | 'inspect' | 'review' | 'finish' | 'revisitGoals' }
  | { type: 'adopt' | 'revise' | 'design' | 'correct' | 'defer' | 'accept'; note: string }
  | { type: 'scope'; contract: Static<typeof ContractSchema> }
  | { type: 'start'; contract?: Static<typeof ContractSchema> }
  | { type: 'switchIssue'; issueId: number }
  | { type: 'switchUnit'; unitId: number };
export const NextSchema = object({ summary: Type.String({ minLength: 1, maxLength: 600 }), unresolved: note, edge: EdgeSchema });
export type Next = { summary: string; unresolved: string; edge: Edge };
export const BoundNextSchema = object({ sequence: Type.Integer({ minimum: 0 }), source: Type.String(), proposal: NextSchema });
export const GuidedSchema = object({
  pending: Type.Optional(BoundNextSchema),
  history: Type.Array(object({ sequence: Type.Integer({ minimum: 0 }), proposal: NextSchema })),
});
