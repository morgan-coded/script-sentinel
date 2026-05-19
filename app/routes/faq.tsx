import { redirect } from "@remix-run/node";

export const loader = () => {
  throw redirect("/faq.html");
};
