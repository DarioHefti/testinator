# Cursor Rules – TypeScript CLI (SOLID, Small Components, README Always Updated)

## Global

- Use **TypeScript** with `strict` mode.
- Keep modules and functions **small** and **single-responsibility** (SOLID).
- Prefer **composition over inheritance**.
- Avoid `any` and static global state.


## README Rules

- `README.md` at project root and `documentation\readme_extended.md`:
  - Always keep as the **main, up-to-date documentation**.
  - After any change to:
    - commands
    - CLI behavior
    - configuration
    - project structure  
    → **immediately update the corresponding README** (description, usage, examples)
    ONLY CHANGE THE README if the change has impacted the readme or should be mentioned.