import "server-only";
import nodemailer from "nodemailer";

export const mailConfigured = () =>
  !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.ALERT_EMAIL_TO);

export async function sendMail(subject: string, text: string, to = process.env.ALERT_EMAIL_TO) {
  if (!mailConfigured() || !to) return false;
  const port = Number(process.env.SMTP_PORT || 587);
  const t = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await t.sendMail({ from: process.env.SMTP_USER, to, subject, text });
  return true;
}
