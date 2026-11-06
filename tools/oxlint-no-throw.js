export default {
  meta: { name: "mentor" },
  rules: {
    "no-direct-throw": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          useResult: "Return a typed Result for expected failures; do not throw in src.",
        },
      },
      create(context) {
        return {
          ThrowStatement(node) {
            context.report({ node, messageId: "useResult" });
          },
        };
      },
    },
  },
};
