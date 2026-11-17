# Contract: RPC additions (`src/shared/rpc-contract.ts`)

- `settings.get/update`: `Settings.context?: ContextSizeSettings` (validated server-side; invalid values rejected with a typed error, previous value kept).
- `model.load` result gains `context: EffectiveContext`.
- `model.list` / advisor response: unchanged; the renderer reads `recommendedCtx` already returned.
- `chat.send` gains optional `force?: boolean`; may return `{ error: "message_exceeds_context", neededTokens, effective }` before any generation starts.
- Errors use the existing typed error shape; no new channel.
