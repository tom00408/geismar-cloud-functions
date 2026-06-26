import { onCall, HttpsError } from 'firebase-functions/v2/https';
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { cutGaensefuesse } from '../utils/cutGaensefuesse';

const REQUIRED: string[] = ['USER_EMAIL', 'USER_PASSWORT', 'SMTP_SERVER', 'SMTP_PORT'];

function getTransporter() {
	const mailUser = process.env.USER_EMAIL!;
	const mailPass = process.env.USER_PASSWORT!;
	const smtpHost = process.env.SMTP_SERVER!;
	const smtpPort = Number(process.env.SMTP_PORT ?? '587');
	return nodemailer.createTransport({
		host: smtpHost,
		port: smtpPort,
		secure: smtpPort === 465,
		auth: { user: mailUser, pass: mailPass },
	} as SMTPTransport.Options);
}

/** E-Mail: "Wir haben deine Sachen bestellt (melden uns wenn sie da sind)" */
export const orderBestelltEmail = onCall(
	{
		region: 'europe-west3',
		memory: '256MiB',
		secrets: REQUIRED,
	},
	async (request) => {
		const data = request.data as { to: string; name: string };
		if (!data?.to || !data?.name) {
			throw new HttpsError('invalid-argument', 'Fehlende Felder (to, name).');
		}

		const subject = 'MTV Geismar Shop – Wir haben deine Sachen bestellt';
		const html = `
<p>Hallo ${cutGaensefuesse(data.name)},</p>
<p>wir haben deine Sachen bestellt.</p>
<p>Wir melden uns, sobald sie da sind.</p>
<p>Mit freundlichen Grüßen,<br>Dein MTV Geismar Team</p>
`;

		const transporter = getTransporter();
		const info = await transporter.sendMail({
			from: `"MTV Geismar Shop" <${process.env.USER_EMAIL}>`,
			to: data.to,
			subject,
			html,
		});

		return {
			success: true,
			messageId: info.messageId,
			info: 'E-Mail „Bestellt“ wurde an ' + data.to + ' gesendet.',
		};
	}
);

/** E-Mail: "Deine Sachen sind da (Abholung immer Donnerstags in der Geschäftsstelle)" */
export const orderAngekommenEmail = onCall(
	{
		region: 'europe-west3',
		memory: '256MiB',
		secrets: REQUIRED,
	},
	async (request) => {
		const data = request.data as { to: string; name: string };
		if (!data?.to || !data?.name) {
			throw new HttpsError('invalid-argument', 'Fehlende Felder (to, name).');
		}

		const subject = 'MTV Geismar Shop – Deine Bestellung ist da';
		const html = `
<p>Hallo ${cutGaensefuesse(data.name)},</p>
<p>deine Bestellung ist da!</p>
<p>Abholung ist immer donnerstags 16-18 Uhr in der Geschäftsstelle.</p>
<p>Am Kalten Born 39A, 37085 Göttingen.</p>
<p>Telefon: 0551 794362</p>
<p>Mit freundlichen Grüßen,<br>Dein MTV Geismar Team</p>
`;

		const transporter = getTransporter();
		const info = await transporter.sendMail({
			from: `"MTV Geismar Shop" <${process.env.USER_EMAIL}>`,
			to: data.to,
			subject,
			html,
		});

		return {
			success: true,
			messageId: info.messageId,
			info: 'E-Mail „Sachen sind da“ wurde an ' + data.to + ' gesendet.',
		};
	}
);
