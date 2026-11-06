module.exports = {
  forbidden: [
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
    { name: "no-unresolved", severity: "error", from: {}, to: { couldNotResolve: true } },
    {
      name: "domain-only-domain",
      severity: "error",
      from: { path: "^src/domain/" },
      to: {
        pathNot:
          "^(src/domain/|node_modules/(neverthrow|typebox)/|node_modules/\\.pnpm/[^/]+/node_modules/(neverthrow|typebox)/)",
      },
    },
    {
      name: "presentation-only-inward",
      severity: "error",
      from: { path: "^src/presentation/" },
      to: {
        pathNot:
          "^(src/(domain|presentation)/|node_modules/neverthrow/|node_modules/\\.pnpm/[^/]+/node_modules/neverthrow/)",
      },
    },
  ],
  options: {
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "node", "default", "types"],
    },
    tsConfig: { fileName: "tsconfig.json" },
    doNotFollow: { path: "node_modules" },
  },
};
