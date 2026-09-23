// A workflow interceptor another plugin might add: it rewrites activity input.
export const interceptors = () => ({
  outbound: [{
    async scheduleActivity(input, next) {
      return next({ ...input, args: [{ ...(input.args[0] ?? {}), rewritten: true }] });
    },
  }],
});
