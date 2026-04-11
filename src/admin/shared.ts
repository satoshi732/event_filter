export const flag = (args: string[], f: string) => args.includes(f);

export const after = (args: string[], f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args.slice(i + 1) : [];
};
