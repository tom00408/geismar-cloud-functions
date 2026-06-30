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

/**
 * Eingangsbestätigung für einen Widerruf nach § 356a Abs. 4 BGB.
 * Sendet dem Verbraucher eine Bestätigung mit Inhalt der Widerrufserklärung
 * sowie Datum und Uhrzeit des Eingangs und benachrichtigt den Shop.
 */
export const shopWiderrufEmail = onCall(
	{
		region: 'europe-west3',
		memory: '256MiB',
		secrets: REQUIRED,
	},
	async (request) => {
		const data = request.data as {
			to: string;
			name: string;
			bestellnummer: string;
			grund?: string;
			eingangAt?: string;
		};

		if (!data?.to || !data?.name || !data?.bestellnummer) {
			throw new HttpsError(
				'invalid-argument',
				'Fehlende Felder (to, name, bestellnummer).'
			);
		}

		const eingang = data.eingangAt ? new Date(data.eingangAt) : new Date();
		const eingangText = eingang.toLocaleString('de-DE', {
			dateStyle: 'long',
			timeStyle: 'short',
			timeZone: 'Europe/Berlin',
		});

		const name = cutGaensefuesse(data.name);
		const bestellnummer = cutGaensefuesse(data.bestellnummer);
		const grund = data.grund ? cutGaensefuesse(data.grund) : '';

		const transporter = getTransporter();

		// 1) Eingangsbestätigung an den Verbraucher
		const subjectKunde = 'MTV Geismar Shop – Eingangsbestätigung Ihres Widerrufs';
		const htmlKunde = `
<p>Hallo ${name},</p>
<p>wir bestätigen den Eingang Ihrer Widerrufserklärung. Diese Bestätigung dient ausschließlich
dem Nachweis des Eingangs und stellt keine inhaltliche Prüfung oder Anerkennung des Widerrufs dar.</p>
<p><b>Inhalt Ihrer Widerrufserklärung:</b></p>
<ul>
  <li>Name: ${name}</li>
  <li>Bestellnummer: ${bestellnummer}</li>
  <li>E-Mail: ${data.to}</li>
  ${grund ? `<li>Angegebener Grund: ${grund}</li>` : ''}
</ul>
<p><b>Eingegangen am:</b> ${eingangText}</p>
<p>Wir setzen uns zur weiteren Abwicklung mit Ihnen in Verbindung.</p>
<p>Mit freundlichen Grüßen,<br>Ihr MTV Geismar Team</p>
`;

		const infoKunde = await transporter.sendMail({
			from: `"MTV Geismar Shop" <${process.env.USER_EMAIL}>`,
			to: data.to,
			subject: subjectKunde,
			html: htmlKunde,
		});

		// 2) Benachrichtigung an den Shop
		const subjectShop = `Neuer Widerruf – Bestellung ${bestellnummer}`;
		const htmlShop = `
<p>Es ist ein neuer Widerruf eingegangen:</p>
<ul>
  <li>Name: ${name}</li>
  <li>Bestellnummer: ${bestellnummer}</li>
  <li>E-Mail: ${data.to}</li>
  ${grund ? `<li>Grund: ${grund}</li>` : ''}
  <li>Eingegangen am: ${eingangText}</li>
</ul>
`;

		try {
			await transporter.sendMail({
				from: `"MTV Geismar Shop" <${process.env.USER_EMAIL}>`,
				to: process.env.USER_EMAIL!,
				subject: subjectShop,
				html: htmlShop,
			});
		} catch (err) {
			console.error('Shop-Benachrichtigung Widerruf fehlgeschlagen:', err);
		}

		return {
			success: true,
			messageId: infoKunde.messageId,
			info: 'Eingangsbestätigung wurde an ' + data.to + ' gesendet.',
		};
	}
);
