import {
  AgentSession, createCodemodeExtension, createReadToolDefinition, createBashToolDefinition,
  createEditToolDefinition, createWriteToolDefinition, type ExtensionAPI, type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

export const defaultPiToolNames = ['read', 'bash', 'edit', 'write'];
export function defaultPiDefinitions(cwd: string): Map<string, ToolDefinition<any, any>> {
  const tools = new Map<string, ToolDefinition<any, any>>;
  for (const tool of [createReadToolDefinition(cwd), createBashToolDefinition(cwd), createEditToolDefinition(cwd), createWriteToolDefinition(cwd)]) tools.set(tool.name, tool);
  createCodemodeExtension()({
    registerTool: (tool: ToolDefinition<any, any>) => tools.set(tool.name, tool),
    getSettings: () => ({}),
  } as unknown as ExtensionAPI);
  return tools;
}

// Exercise installed Pi 1.0.4 loadout logic without constructing model/auth/resource services.
// These private methods are intentionally confined to this version-specific integration fixture.
export function piLoadout(definitions: Map<string, any>, active: string[]) {
  const session = Object.create(AgentSession.prototype);
  session._toolRegistry = definitions;
  session._toolDefinitions = new Map([...definitions].map(([name, definition]) => [name, { definition, sourceInfo: { path: 'loadout-fixture' } }]));
  session._toolPromptGuidelines = new Map([...definitions].map(([name, definition]) => [name, definition.promptGuidelines ?? []]));
  session.agent = { state: { tools: [] } };
  session._extensionRunner = { emitError(error: unknown) { throw new Error(`Pi loadout failed: ${JSON.stringify(error)}`); } };
  const prepared: any[] = session._applyToolLoadout(active);
  const declared = prepared.filter(tool => !session._hiddenDeclarations.has(tool.name));
  const callable: any[] = session._getCallableTools();
  return { declared, callable };
}

export function loadoutSize(loadout: ReturnType<typeof piLoadout>) {
  const declarations = loadout.declared.map(({ name, description, parameters }) => ({ name, description, parameters }));
  return {
    declarationChars: JSON.stringify(declarations).length,
    codemodeDescriptionChars: loadout.declared.find(tool => tool.name === 'codemode')?.description.length ?? 0,
    declaredNames: loadout.declared.map(tool => tool.name),
  };
}
