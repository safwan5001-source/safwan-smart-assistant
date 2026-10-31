import type { SVGProps } from "react";
export type AppIconName = "home" | "chat" | "integrations" | "tasks" | "files" | "calls" | "settings";
const paths: Record<AppIconName, React.ReactNode> = {
 home: <><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/></>,
 chat: <><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-3 2v-7.5A7.5 7.5 0 0 1 10.5 6H12a8 8 0 0 1 8 5.5Z"/><path d="M8 12h8M8 15h5"/></>,
 integrations: <><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><path d="M17 13v8m-4-4h8"/></>,
 tasks: <><rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 10 2 2 4-4M8 16h8"/></>,
 files: <><path d="M4 4h6l2 2h8v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M4 9h16"/></>,
 calls: <><path d="M7 3H5a2 2 0 0 0-2 2c0 9 7 16 16 16a2 2 0 0 0 2-2v-2l-5-2-3 3a15 15 0 0 1-7-7l3-3z"/></>,
 settings: <><path d="M10 2h4l.7 2.5 2 .9 2.3-1.1 2.8 2.8-1.1 2.3.9 2L24 12l-2.4 1-.9 2 1.1 2.3-2.8 2.8-2.3-1.1-2 .9L14 22h-4l-.7-2.5-2-.9L5 19.7l-2.8-2.8 1.1-2.3-.9-2L0 12l2.4-1 .9-2-1.1-2.3L5 3.9l2.3 1.1 2-.9z" transform="translate(1 0) scale(.92)"/><circle cx="12" cy="12" r="3"/></>
};
export default function AppIcon({name,...props}:{name:AppIconName}&SVGProps<SVGSVGElement>){
 return <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}
