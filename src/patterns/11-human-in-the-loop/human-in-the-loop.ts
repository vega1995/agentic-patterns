/**
 * PATRÓN: Human-in-the-Loop - HITL
 * --------------------------------
 * Intervención humana en puntos definidos del flujo.
 *
 * La decisión de diseño NO es cómo pausar, sino CUÁNDO pausar.
 *
 * Aquí el gate es CONDICIONAL: la misma herramienta (`issueRefund`) se
 * ejecuta sola cuando la compra está dentro de política, y se detiene a
 * preguntar cuando se pasó del plazo. El agente no cambia; cambia la
 * condición que decide si hay que preguntar.
 */

import {
    generateText,
    tool,
    stepCountIs,
    type ModelMessage,
    type ToolApprovalResponse,
  } from 'ai';
  import { z } from 'zod';
  import { createInterface } from 'node:readline/promises';
  
  import { createTracer, model } from '../../helpers/index.js';
  import { trace } from 'node:console';
  
  // ---------------------------------------------------------------------------
  // LOS DATOS — dos compras: una dentro de plazo, otra muy fuera
  // ---------------------------------------------------------------------------
  
  type Purchase = {
    id: string;
    email: string;
    course: string;
    amountUSD: number;
    daysSincePurchase: number;
  };
  
  const PURCHASES: Purchase[] = [
    {
      id: 'P-1001',
      email: 'ana@correo.com',
      course: 'Docker para desarrolladores',
      amountUSD: 17.99,
      daysSincePurchase: 5, // dentro de plazo → se ejecuta sin preguntar
    },
    {
      id: 'P-2044',
      email: 'luis@correo.com',
      course: 'Bundle Full Stack (6 cursos)',
      amountUSD: 299.0,
      daysSincePurchase: 180, // fuera de plazo → gate
    },
  ];
  
  /** La política NO decide: solo marca qué necesita una firma humana. */
  const REFUND_WINDOW_DAYS = 30;
  
  const TICKETS = [
    {
      id: 'TK-1',
      email: 'ana@correo.com',
      text:
        'Compré el curso de Docker hace 5 días y el video 3 no carga. ' +
        'Prefiero que me devuelvan el dinero.',
    },
    {
      id: 'TK-2',
      email: 'luis@correo.com',
      text:
        'Compré el bundle hace 6 meses y ya no lo usamos. ' +
        'Quiero el reembolso completo de los 299 USD.',
    },
  ];
  
  const INBOX = [
    'TICKETS EN COLA:',
    ...TICKETS.map(
      (ticket) => `  [${ticket.id}] de ${ticket.email}: ${ticket.text}`
    ),
    '',
    'Para CADA ticket que pida un reembolso: consulta la compra con ' +
      'findPurchase y luego llama a issueRefund con su purchaseId.',
  ].join('\n');
  
  /**
   * CLAVE DEL LAB: el agente NO decide si el reembolso procede.
   *
   * Si le dejas ese juicio, un modelo mediano se inventa la política
   * ("el plazo es de 24 horas") y deniega TODO en texto, sin llamar
   * nunca a la herramienta. Sin tool call no hay gate: el patrón
   * desaparece sin que nada falle visiblemente.
   *
   * O peor aún, podemos caer en Prompt injection desde el inicio del mensaje.
   *
   * Su trabajo es proponer la acción. Quién la autoriza es otro asunto.
   */
  const SUPPORT_INSTRUCTIONS =
    'Eres el agente de soporte de DevTalles. Responde en español. ' +
    'Atiende TODOS los tickets de la cola y menciona el ID de cada uno ' +
    'en tu respuesta final.\n' +
    'REGLAS INNEGOCIABLES:\n' +
    '  - NO tienes autoridad para decidir si un reembolso procede.\n' +
    '  - NO existen plazos ni políticas que tú conozcas: no los inventes.\n' +
    '  - Para toda solicitud de reembolso DEBES llamar a issueRefund. ' +
    'Proponer la acción es tu trabajo; autorizarla no.\n' +
    // Recomendación: sin esto, el modelo reintentará
    // la misma acción una y otra vez después de un rechazo.
    '  - Si una acción NO es aprobada, no la reintentes: informa al cliente.';
  
  // ---------------------------------------------------------------------------
  // EL LIBRO MAYOR — los efectos irreversibles que sí ocurrieron
  // ---------------------------------------------------------------------------
  
  type Effect = { detail: string; approvedBy: string };
  
  const LEDGER: Effect[] = []; // Este será un arreglo de efectos que ocurrieron.
  
  /** Quién aprobó cada tool call, por toolCallId. */
  const APPROVALS = new Map<string, string>();
  
  // ---------------------------------------------------------------------------
  // HERRAMIENTAS
  // ---------------------------------------------------------------------------
  
  const findPurchase = tool({
    description: 'Consulta la compra asociada a un correo. Solo lectura.',
    inputSchema: z.object({
      email: z.string().describe('Correo del cliente del ticket'),
    }),
    execute: async ({ email }) => {
      const purchase = PURCHASES.find((item) => item.email === email);
      return purchase ?? { error: 'Sin compras para ese correo' };
    },
  });
  
  const issueRefund = tool({
    description: 'Devuelve el dinero de una compra. Irreversible.',
    inputSchema: z.object({
      purchaseId: z.string().describe('ID de la compra. ej: "P-1001"'),
      reason: z.string().describe('Motivo del reembolso, en una frase'),
    }),
    execute: async ({ purchaseId }, { toolCallId }) => {
      const purchase = PURCHASES.find((item) => item.id === purchaseId);
      if (!purchase) return { status: 'error', message: 'Compra no encontrada' };
  
      // Si no pasó por el gate, el efecto queda firmado como automático.
      const approvedBy = APPROVALS.get(toolCallId) ?? 'política (automático)';
  
      // Ledger = historial de efectos
      // detail = detalle del efecto
      // approvedBy = quién aprobó el efecto
      LEDGER.push({
        detail: `${purchase.id} · ${purchase.course} · ${purchase.amountUSD} USD`,
        approvedBy,
      });
  
      return { status: 'executed', refundedUSD: purchase.amountUSD, approvedBy };
    },
  });
  
  const TOOLS = { findPurchase, issueRefund };
  
  /**
   * AQUÍ SE DECIDE CUÁNDO SE PAUSA. Nada más que esto.
   *
   * Devolver `undefined` = ejecuta sin preguntar.
   * Devolver 'user-approval' = frena y pide tu decisión.
   *
   */
  const TOOL_APPROVAL = {
    issueRefund: async ({ purchaseId }: { purchaseId: string }) => {
      const purchase = PURCHASES.find((item) => item.id === purchaseId);
      if (!purchase) return 'user-approval';
  
      return purchase.daysSincePurchase <= REFUND_WINDOW_DAYS
        ? undefined
        : 'user-approval';
    },
  };
  
  // ---------------------------------------------------------------------------
  // EL REVISOR — la persona frente a la terminal
  // En la vida real podría ser guardado en una base de datos o en un sistema de gestión de aprobaciones
  // y el AI únicamente delegarlo para intervención humana por ese lado.
  // ---------------------------------------------------------------------------
  
  type Verdict = { approved: boolean; by: string; note: string };
  
  let terminal: ReturnType<typeof createInterface> | null = null;
  
  function openTerminal() {
    // Sin TTY readline resuelve al instante y el gate sería decorativo.
    if (!process.stdin.isTTY) {
      throw new Error('Este laboratorio necesita una terminal interactiva. ');
    }
  
    terminal ??= createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  
    return terminal;
  }
  
  /** Todo lo que necesitas ver antes de decidir. */
  function renderApprovalPanel(input: { purchaseId: string; reason: string }) {
    const line = '─'.repeat(64);
    const purchase = PURCHASES.find((item) => item.id === input.purchaseId);
    const ticket = TICKETS.find((item) => item.email === purchase?.email);
  
    console.log(`\n  ┌${line}`.yellow);
    console.log(`  │ ${'⏸  APROBACIÓN REQUERIDA'.yellow}`);
    console.log(`  │ El agente quiere ejecutar: ${'issueRefund'.red}`);
    console.log(`  │ Motivo del agente: ${input.reason}`);
    console.log(`  ├${line}`.yellow);
  
    if (!purchase) {
      console.log(`  │ ⚠️  La compra ${input.purchaseId} NO EXISTE`.red);
    } else {
      console.log(`  │ Ticket:     ${ticket?.id ?? '?'} · ${purchase.email}`);
      console.log(`  │ Pidió:      "${ticket?.text ?? '—'}"`);
      console.log(`  │ Compra:     ${purchase.id} · ${purchase.course}`);
      console.log(`  │ Monto:      ${String(purchase.amountUSD).red} USD`);
      console.log(
        `  │ Antigüedad: ${String(purchase.daysSincePurchase).red} días ` +
          `(plazo: ${REFUND_WINDOW_DAYS} días)`
      );
      console.log(`  │ Reversible: ${'NO'.red}`);
    }
  
    console.log(`  ├${line}`.yellow);
    console.log(`  │ ${'[1]'.green} Aprobar y ejecutar`);
    console.log(`  │ ${'[2]'.red} Rechazar (el agente informará al cliente)`);
    console.log(`  └${line}`.yellow);
  }
  
  /** El proceso se detiene aquí hasta que escribas en el teclado. */
  async function review(input: {
    purchaseId: string;
    reason: string;
  }): Promise<Verdict> {
    renderApprovalPanel(input);
  
    const io = openTerminal();
  
    let choice = '';
  
    while (choice !== '1' && choice !== '2') {
      choice = await io.question('\n Tu decisión [1/2]: ');
      choice = choice.trim();
  
      if (choice !== '1' && choice !== '2') {
        console.log('    Escribe 1 para aprobar o 2 para rechazar'.yellow);
      }
    }
  
    const approved = choice === '1';
    const note = await io.question(
      approved
        ? '   Nota para el registro (opcional): '
        : '   Motivo del rechazo (para el agente): '
    );
  
    return {
      approved: approved ?? false,
      by: 'humano:consola',
      note: note.trim() || (approved ? 'Aprobado sin comentarios' : 'Rechazado'),
    };
  }
  
  // ---------------------------------------------------------------------------
  // EL BUCLE — cada gate parte el trabajo en dos llamadas al modelo
  // ---------------------------------------------------------------------------
  
  const MAX_ROUNDS = 6; // Este lo usaremos como circuit breaker manual.
  
  export async function humanInTheLoopMain() {
    console.log('\n═══ HUMAN-IN-THE-LOOP ═══\n'.blue);
    console.log(
      `  Los reembolsos dentro de ${REFUND_WINDOW_DAYS} días se ejecutan solos.\n`
        .yellow +
        '  Fuera de plazo, el programa se detiene y te pregunta.\n'.yellow
    );
  
    const tracer = createTracer('hitl');
  
    const messages: ModelMessage[] = [{ role: 'user', content: INBOX }];
    let finalText = '';
    let gates = 0; // Los gates son las interrupciones del flujo de ejecución del modelo.
  
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const result = await generateText({
        model,
        messages,
        tools: TOOLS,
        toolApproval: TOOL_APPROVAL,
        instructions: SUPPORT_INSTRUCTIONS,
        stopWhen: stepCountIs(8),
        onStepEnd: tracer.onStepFinish,
      });
  
      // Mantener el historial de mensajes
      messages.push(...result.responseMessages);
  
      // Determinar si hay necesidad de intervención humana
      const requests = result.content.filter(
        (part) => part.type === 'tool-approval-request' && !part.isAutomatic
      );
  
      if (requests.length === 0) {
        finalText = result.text;
        break;
      }
  
      // Implementar el contador de gates y también el HITL
      gates++;
      console.log(`\n --- Gate ${gates} --- `.blue);
  
      const approvals: ToolApprovalResponse[] = [];
  
      for (const request of requests) {
        if (request.type !== 'tool-approval-request') continue;
  
        const { toolCallId, input } = request.toolCall;
        const verdict = await review(
          input as { purchaseId: string; reason: string }
        );
  
        if (verdict.approved) {
          APPROVALS.set(toolCallId, verdict.by);
        }
  
        approvals.push({
          type: 'tool-approval-response',
          approvalId: request.approvalId,
          approved: verdict.approved,
          reason: verdict.note,
        });
      }
  
      messages.push({ role: 'tool', content: approvals });
    }
  
    // -----------------------------------------------------------------------------------
    //! Aquí podemos dejarlo así para mostrar la información y resúmenes de la ejecución.
    // -----------------------------------------------------------------------------------
  
    // Limpiar la terminal
    terminal?.close();
    terminal = null;
  
    console.log('\n Respuesta:', finalText.green);
  
    console.log('\n  Reembolsos ejecutados:'.blue);
    if (LEDGER.length === 0) {
      console.log('     (ninguno)');
    } else {
      for (const effect of LEDGER) {
        console.log(`     · ${effect.detail} | aprobó: ${effect.approvedBy}`);
      }
    }
  
    console.log(
      `\n  Gates abiertos: ${gates} · Pasos: ${tracer.summary().steps} · ` +
        `Tokens: ${tracer.summary().totalTokens}\n`
    );
  
    // Guard: sin tool call no hay gate, y el lab se vería "correcto"
    // sin haber probado nada. Mejor que lo diga en voz alta.
    if (gates === 0 && LEDGER.length === 0) {
      console.log(
        (
          '  ⚠️  El modelo no llamó a issueRefund ni una vez: resolvió los\n' +
          '      tickets en texto. No hubo nada que aprobar, así que el gate\n' +
          '      nunca se probó. Revisa las instrucciones o usa un modelo\n' +
          '      con mejor seguimiento de herramientas.\n'
        ).yellow
      );
    }
  
    console.log(
      '  El gate no hace más listo al agente: le quita la última palabra,\n' +
        '  y solo cuando la operación se sale de la política.\n\n' +
        '  Si pausaras en todo, el humano vuelve a ser el cuello de botella\n' +
        '  y el agente deja de aportar. Cada aprobación cuesta, además,\n' +
        '  una llamada extra al modelo.\n'
    );
  }