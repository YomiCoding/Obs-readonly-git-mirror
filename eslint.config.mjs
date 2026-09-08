// 复现官方自动审核用的那套规则。审核明确不允许禁用 no-explicit-any，
// 而带类型的 no-unsafe-* 系列只有开了 projectService 才会真正生效 ——
// 不开的话本地全绿、提交上去照样一堆告警。
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
);
