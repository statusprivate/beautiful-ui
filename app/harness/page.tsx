import type { Metadata } from "next";
import JarvisApp from "@/components/jarvis/JarvisApp";

export const metadata: Metadata = {
  title: "Jarvis",
  description:
    "Your personal assistant for conversations, files and getting things done.",
};

export default function HarnessPage() {
  return <JarvisApp />;
}
