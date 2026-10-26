import { redirect } from "next/navigation";
import { Shell } from "@/components/shell";
import { currentUser } from "@/server/http";

export const dynamic = "force-dynamic";

export default async function DashLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  return <Shell user={{ name: user.name, email: user.email, role: user.role }}>{children}</Shell>;
}
