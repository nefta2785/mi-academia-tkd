import { Component, onWillStart, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { standardActionServiceProps } from "@web/webclient/actions/action_service";
import { PanelCalificacion } from "./panel_calificacion";

// Mismo orden de progresión que la Selection de cinta_actual/cinta_evaluada
// en Python. Lo usamos para que "ordenar por Cinta" siga el avance real de
// las cintas y no el orden alfabético (que mezclaría amarilla antes que azul
// antes que blanca, sin sentido para una academia de taekwondo).
const ORDEN_CINTAS = [
    "blanca", "naranja", "naranja_avanzada", "amarilla", "amarilla_avanzada",
    "verde", "verde_avanzada", "azul", "azul_avanzada", "roja", "roja_avanzada", "negra",
];
const RANGO_CINTA = Object.fromEntries(ORDEN_CINTAS.map((cinta, indice) => [cinta, indice]));

export class TableroCalificacion extends Component {
    static template = "mi_primer_modulo.TableroCalificacion";
    static components = { PanelCalificacion };
    static props = {
        ...standardActionServiceProps,
    };

    setup() {
        this.orm = useService("orm");

        this.state = useState({
            cargando: true,
            roster: [],
            mesa: [],
            ordenPor: "edad",
            expandido: null,
            progreso: {},
        });

        onWillStart(async () => {
            const eventoId = this.props.action.params.evento_id;

            const examenes = await this.orm.searchRead(
                "taekwondo.examen",
                [["evento_id", "=", eventoId]],
                ["alumno_id", "cinta_evaluada", "resultado", "mejor_examen"]
            );

            const alumnoIds = [...new Set(examenes.map((examen) => examen.alumno_id[0]))];

            // UNA sola llamada trae los datos de TODOS los alumnos del
            // roster juntos, en vez de un viaje al servidor por cada uno.
            const alumnos = await this.orm.read(
                "taekwondo.alumno",
                alumnoIds,
                ["name", "foto", "edad"]
            );
            const alumnosPorId = Object.fromEntries(
                alumnos.map((alumno) => [alumno.id, alumno])
            );

            // orm.read/searchRead traen el valor CRUDO de un campo Selection
            // (la clave técnica, ej. "verde_avanzada"), no la etiqueta
            // traducida - esa traducción normalmente la hace el widget de
            // las vistas estándar de Odoo, usando la metadata del campo que
            // trae fields_get. Como aquí no hay vista ni widget, la pedimos
            // nosotros mismos, UNA sola vez (no por cada examen).
            const camposExamen = await this.orm.call("taekwondo.examen", "fields_get", [], {
                allfields: ["cinta_evaluada"],
                attributes: ["selection"],
            });
            const cintaLabels = Object.fromEntries(camposExamen.cinta_evaluada.selection);

            this.state.roster = examenes.map((examen) => {
                const alumno = alumnosPorId[examen.alumno_id[0]];
                return {
                    examenId: examen.id,
                    name: alumno.name,
                    foto: alumno.foto,
                    edad: alumno.edad,
                    // Guardamos AMBOS: el valor crudo (cintaEvaluada) sigue
                    // siendo necesario para ordenar con RANGO_CINTA, y la
                    // etiqueta (cintaEvaluadaLabel) es la que se muestra.
                    cintaEvaluada: examen.cinta_evaluada,
                    cintaEvaluadaLabel: cintaLabels[examen.cinta_evaluada] || examen.cinta_evaluada,
                    resultado: examen.resultado,
                    mejorExamen: examen.mejor_examen,
                };
            });

            // Otra llamada batch (no una por examen): trae de un solo golpe
            // los criterios de TODOS los exámenes del evento, y con eso
            // contamos cuántos ya tienen calificación por examen.
            const criteriosTodos = await this.orm.searchRead(
                "taekwondo.criterio_calificacion",
                [["examen_id", "in", examenes.map((examen) => examen.id)]],
                ["examen_id", "calificacion"]
            );
            const progreso = Object.fromEntries(examenes.map((examen) => [examen.id, 0]));
            for (const criterio of criteriosTodos) {
                if (criterio.calificacion) {
                    progreso[criterio.examen_id[0]] += 1;
                }
            }
            this.state.progreso = progreso;

            this.state.cargando = false;
        });
    }

    get rosterOrdenado() {
        // Copiamos el arreglo antes de ordenar: sort() ordena "en el lugar",
        // y modificar el estado reactivo directamente desde un getter que
        // se llama en cada render es una mala práctica (podría disparar
        // renders extra o dejar el orden inconsistente entre pantallas).
        const roster = [...this.state.roster];
        if (this.state.ordenPor === "edad") {
            roster.sort((a, b) => a.edad - b.edad);
        } else {
            roster.sort((a, b) => RANGO_CINTA[a.cintaEvaluada] - RANGO_CINTA[b.cintaEvaluada]);
        }
        return roster;
    }

    get rosterPorExamenId() {
        return Object.fromEntries(this.state.roster.map((item) => [item.examenId, item]));
    }

    ordenarPor(criterio) {
        this.state.ordenPor = criterio;
    }

    expandir(examenId) {
        this.state.expandido = examenId;
    }

    regresar() {
        this.state.expandido = null;
    }

    agregarAMesa(examenId) {
        if (!this.state.mesa.includes(examenId)) {
            this.state.mesa.push(examenId);
        }
    }

    quitarDeMesa(examenId) {
        this.state.mesa = this.state.mesa.filter((id) => id !== examenId);
    }

    async onCriterioGuardado(examenId) {
        // Solo repreguntamos por ESTE examen (4 filas), no por todo el
        // evento de nuevo: mismo espíritu de "batch, no uno por uno" pero
        // aplicado a la actualización puntual que sí necesitamos aquí.
        const criterios = await this.orm.searchRead(
            "taekwondo.criterio_calificacion",
            [["examen_id", "=", examenId]],
            ["calificacion"]
        );
        this.state.progreso[examenId] = criterios.filter((c) => c.calificacion).length;
    }

    onResultadoCambiado(examenId, valor) {
        // A diferencia de onCriterioGuardado, aquí NO volvemos a preguntarle
        // al servidor: el Panel ya sabe con certeza qué valor acaba de
        // escribir (él mismo lo mandó), así que nos lo pasa directo y solo
        // actualizamos el estado local. rosterPorExamenId[examenId] es la
        // MISMA referencia de objeto que vive dentro de state.roster (el
        // getter solo la busca, no la copia), así que mutarla aquí sí
        // dispara el re-render de quien esté leyendo ese dato.
        const item = this.rosterPorExamenId[examenId];
        if (item) {
            item.resultado = valor;
        }
    }

    onMejorExamenCambiado(examenId, valor) {
        // Mismo mecanismo que onResultadoCambiado: el Panel ya sabe el
        // valor exacto, así que solo actualizamos la referencia local.
        const item = this.rosterPorExamenId[examenId];
        if (item) {
            item.mejorExamen = valor;
        }
    }
}

registry.category("actions").add("mi_primer_modulo.tablero_calificacion", TableroCalificacion);
