/**
 * PATRÓN: Uso de herramientas - Tool use
 * ---------------------------
 * El catálogo de cursos NO está en el entrenamiento
 * del modelo. Sin herramientas, el modelo inventa precios y cursos con
 * total confianza o en su defecto, no hace nada.
 * Con herramientas, consulta el dato real.
 */

import { generateText, tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { createTracer, model } from '../../helpers/index.js';

// ---------------------------------------------------------------------------
//  LA "BASE DE DATOS" — datos que el modelo no puede conocer
// ---------------------------------------------------------------------------

type Course = {
    id: string;
    title: string;
    hours: number;
    priceUSD: number;
    level: 'basic' | 'intermediate' | 'advanced';
    students: number;
};

const COURSE_CATALOG: Course[] = [
    {
        id: 'ts-01',
        title: 'TypeScript desde cero',
        hours: 22,
        priceUSD: 19.99,
        level: 'basic',
        students: 48_120,
    },
    {
        id: 'nest-02',
        title: 'NestJS: API REST modular',
        hours: 31,
        priceUSD: 24.99,
        level: 'intermediate',
        students: 22_450,
    },
    {
        id: 'flu-03',
        title: 'Flutter: apps multiplataforma',
        hours: 46,
        priceUSD: 29.99,
        level: 'intermediate',
        students: 61_300,
    },
    {
        id: 'agt-04',
        title: 'Agentes de IA con TypeScript',
        hours: 18,
        priceUSD: 34.99,
        level: 'advanced',
        students: 1_890,
    },
    {
        id: 'dkr-05',
        title: 'Docker para desarrolladores',
        hours: 14,
        priceUSD: 17.99,
        level: 'basic',
        students: 35_770,
    },
];

const QUESTION = `
¿Cuánto costarían juntos el curso de TypeScript y el curso de Docker?
Con un 20% de descuento?. Dame támbien las horas totales.`;



async function withoutToolUse() {

    const tracer = createTracer('sin herramientas');

    const { text } = await generateText({
        model: model,
        prompt: QUESTION,
        onStepEnd: tracer.onStepFinish,

    });
    console.log('\n Respuesta sin herramientas: \n', text.green);
    console.log('\n Verifcar los números contra el catalogo de cursos');
    console.log('--------------------------------');

    return tracer.summary();

}
//! ========================TODO: Implementar la función con herramientas

//tool #1: encontrar cursos
const findCourser = tool(
    {
        description: 'Buscar cursos en el catalogo de cursos DevDetalles, por texto, por titulo o por nivel.' +
            'Utilizala siempre antes de responder cualquier pregunta sobre cursos, precios, cantidad de alumnos',
        inputSchema: z.object({
            text: z
                .string()
                .optional()
                .describe('Texto a buscar en el titulo del curso'),
            level: z.enum(['basic', 'intermediate', 'advanced']).optional()
        }),
        execute: async ({ text, level }) => {
            const filtreredCourses = COURSE_CATALOG.filter((course) => {
                const matchesText = !text || course.title.toLowerCase().includes(text.toLowerCase());
                const matchesLevel = !level || course.level === level;
                return matchesText && matchesLevel;
            })

            return {
                found: filtreredCourses.length,
                courses: filtreredCourses
            }
        }
    }
)

const calculateTotal = tool({
    description:
      'Calcula el precio total de una lista de cursos aplicando un descuento porcentual. ' +
      'Utilízala siempre para cualquier operación aritmética: no calcules mentalmente.',
    inputSchema: z.object({
      ids: z
        .array(z.string())
        .describe('IDs de los cursos. ej: ["ts-01","dkr-0523"]'),
      discountPercent: z.number().min(0).max(100).default(0),
    }),
    execute: async ({ ids, discountPercent }) => {
      const foundCourses = COURSE_CATALOG.filter((course) =>
        ids.includes(course.id)
      );
  
      const notFound = ids.filter(
        (id) => !COURSE_CATALOG.some((course) => course.id === id)
      );
  
      const subtotal = foundCourses.reduce(
        (acc, course) => acc + course.priceUSD,
        0
      );
  
      const discount = subtotal * (discountPercent / 100);
  
      return {
        subtotal: Number(subtotal.toFixed(2)),
        discount: Number(discount.toFixed(2)),
        total: Number((subtotal - discount).toFixed(2)),
        notFound: notFound,
      };
    },
  });
async function withToolUse() {

    const tracer = createTracer('sin herramientas');

    const { text } = await generateText({
        model: model,
        prompt: QUESTION,
        tools: { findCourser,calculateTotal },
        stopWhen:stepCountIs(6),
        instructions: 'Eres un asistente del catálogo de cursos de devtalles. No inventes precios, duracion ni nombres de cursos.' +
            ' Consúltalos siempre con las herramientas disponibles',
        onStepEnd: tracer.onStepFinish,

    });
    console.log('\n Respuesta sin herramientas: \n', text.green);
    console.log('\n Verifcar los números contra el catalogo de cursos');
    console.log('--------------------------------');

    return tracer.summary();

}



export async function toolUseMain() {
   // const resultA = await withoutToolUse();
    const resultB = await withToolUse();
    console.log('\n Comparativa');
    console.log('--------------------------------');
    console.table({
       // 'Sin herramientas': resultA,
        'Con herramientas': resultB,
    });
}