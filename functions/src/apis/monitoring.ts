import { onRequest } from 'firebase-functions/v2/https';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

if (!getApps().length) {
	initializeApp();
}

const REGION = 'europe-west3';

// Vom Client gemeldete Fehler (Dashboard, Shop, …) landen in monitoringErrors
// und werden in der Admin-App angezeigt. Bewusst onRequest statt onCall,
// damit auch Apps ohne Firebase-SDK (sendBeacon/fetch) loggen können.
export const logClientError = onRequest(
	{ region: REGION, cors: true, maxInstances: 2 },
	async (req, res) => {
		if (req.method !== 'POST') {
			res.status(405).send('POST only');
			return;
		}
		const b = (req.body ?? {}) as Record<string, unknown>;
		const str = (v: unknown, max: number) =>
			typeof v === 'string' ? v.slice(0, max) : '';

		const message = str(b.message, 2000);
		if (!message) {
			res.status(400).send('message fehlt');
			return;
		}

		// simples Flut-Limit: identische Meldung derselben App innerhalb
		// von 5 Minuten nur zählen statt neu anlegen
		const db = getFirestore();
		const app = str(b.app, 50) || 'unbekannt';
		const cutoff = new Date(Date.now() - 5 * 60_000);
		const dup = await db
			.collection('monitoringErrors')
			.where('app', '==', app)
			.where('message', '==', message)
			.where('createdAt', '>', cutoff)
			.limit(1)
			.get();
		if (!dup.empty) {
			await dup.docs[0].ref.update({
				count: FieldValue.increment(1),
				lastSeenAt: FieldValue.serverTimestamp(),
			});
			res.status(204).send('');
			return;
		}

		await db.collection('monitoringErrors').add({
			app,
			message,
			stack: str(b.stack, 8000),
			url: str(b.url, 500),
			userAgent: str(b.userAgent, 300),
			severity: str(b.severity, 20) || 'error',
			count: 1,
			gelesen: false,
			createdAt: FieldValue.serverTimestamp(),
			lastSeenAt: FieldValue.serverTimestamp(),
		});
		res.status(204).send('');
	}
);
