import { redirect } from "next/navigation";

/** The app has no dashboard yet; contacts is the landing screen. */
export default function Home() {
  redirect("/contacts");
}
