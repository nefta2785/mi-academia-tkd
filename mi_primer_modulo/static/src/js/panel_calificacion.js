import { Component, onWillStart, useState } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";

const CATEGORIA_LABELS = {
    basicos: "Básicos",
    poomse: "Poomse",
    kiorugui: "Kiorugui",
    kiopka: "Kiopka",
};

const OPCIONES_CALIFICACION = [
    { valor: "R", etiqueta: "Regular" },
    { valor: "B", etiqueta: "Bueno" },
    { valor: "MB", etiqueta: "Muy Bueno" },
    { valor: "E", etiqueta: "Excelente" },
];

const OPCIONES_RESULTADO = [
    { valor: "aprobado", etiqueta: "Aprobado" },
    { valor: "reprobado", etiqueta: "Reprobado" },
    { valor: "pendiente", etiqueta: "Pendiente" },
];

export class PanelCalificacion extends Component {
    static template = "mi_primer_modulo.PanelCalificacion";
    static props = {
        examenId: Number,
        onGuardado: Function,
        onResultadoCambiado: Function,
        onMejorExamenCambiado: Function,
    };

    setup() {
        this.orm = useService("orm");
        this.categoriaLabels = CATEGORIA_LABELS;
        this.opcionesCalificacion = OPCIONES_CALIFICACION;
        this.opcionesResultado = OPCIONES_RESULTADO;

        this.state = useState({
            cargando: true,
            alumno: { name: "", foto: false, edad: 0 },
            cintaEvaluada: "",
            criterios: [],
            resultado: "pendiente",
            notasSinodal: "",
            mejorExamen: false,
            mensajeGuardado: false,
        });

        onWillStart(async () => {
            const [examen] = await this.orm.read(
                "taekwondo.examen",
                [this.props.examenId],
                ["alumno_id", "cinta_evaluada", "criterios_ids", "resultado", "notas_sinodal", "mejor_examen"]
            );
            const [alumno] = await this.orm.read(
                "taekwondo.alumno",
                [examen.alumno_id[0]],
                ["name", "foto", "edad"]
            );
            const criterios = await this.orm.read(
                "taekwondo.criterio_calificacion",
                examen.criterios_ids,
                ["categoria", "calificacion", "comentario"]
            );

            // orm.read trae el valor crudo de un Selection (la clave
            // técnica), no la etiqueta traducida; fields_get es la forma
            // correcta de pedirle al servidor esa traducción.
            const camposExamen = await this.orm.call("taekwondo.examen", "fields_get", [], {
                allfields: ["cinta_evaluada"],
                attributes: ["selection"],
            });
            const cintaLabels = Object.fromEntries(camposExamen.cinta_evaluada.selection);

            this.state.alumno = alumno;
            this.state.cintaEvaluada = cintaLabels[examen.cinta_evaluada] || examen.cinta_evaluada;
            this.state.resultado = examen.resultado;
            // Mismo motivo que con el comentario por categoría: un Text
            // vacío llega como `false`, no como "".
            this.state.notasSinodal = examen.notas_sinodal || "";
            this.state.mejorExamen = examen.mejor_examen;
            // El comentario llega como `false` cuando está vacío (así lo
            // guarda Odoo un campo Text sin valor); lo normalizamos a texto
            // vacío para que el <textarea> no truene al enlazarlo con t-model.
            this.state.criterios = criterios.map((criterio) => ({
                ...criterio,
                comentario: criterio.comentario || "",
            }));
            this.state.cargando = false;
        });
    }

    getEtiquetaCategoria(categoria) {
        return this.categoriaLabels[categoria] || categoria;
    }

    mostrarConfirmacionGuardado() {
        // Si ya había un mensaje contando hacia abajo, lo cancelamos antes
        // de empezar uno nuevo: así dos guardados seguidos reinician el
        // conteo de 1800ms en vez de que el primer timer apague el mensaje
        // a mitad del segundo guardado.
        clearTimeout(this.guardadoTimer);
        this.state.mensajeGuardado = true;
        this.guardadoTimer = setTimeout(() => {
            this.state.mensajeGuardado = false;
        }, 1800);
    }

    async calificar(criterio, valor) {
        // Resaltamos el botón de inmediato (estado local ya reactivo);
        // el guardado real ocurre aparte, en paralelo a lo que ve el ojo.
        criterio.calificacion = valor;
        await this.orm.write("taekwondo.criterio_calificacion", [criterio.id], {
            calificacion: valor,
        });
        this.mostrarConfirmacionGuardado();
        // Avisamos al Tablero (el padre) que este examen tiene una
        // calificación nueva, para que actualice el contador "x/4" de
        // la tarjeta compacta. El Panel no sabe nada de tarjetas ni de
        // mesa - solo llama a la función que el padre le pasó como prop.
        this.props.onGuardado(this.props.examenId);
    }

    async guardarComentario(criterio, ev) {
        await this.orm.write("taekwondo.criterio_calificacion", [criterio.id], {
            comentario: ev.target.value,
        });
        this.mostrarConfirmacionGuardado();
    }

    async marcarResultado(valor) {
        // Mismo patrón que calificar(): resaltar de inmediato en el estado
        // local, guardar en el servidor, y avisar con el mismo mensaje
        // "✓ Guardado" que ya usan las categorías.
        this.state.resultado = valor;
        await this.orm.write("taekwondo.examen", [this.props.examenId], {
            resultado: valor,
        });
        this.mostrarConfirmacionGuardado();
        this.props.onResultadoCambiado(this.props.examenId, valor);
    }

    async guardarNotasSinodal(ev) {
        await this.orm.write("taekwondo.examen", [this.props.examenId], {
            notas_sinodal: ev.target.value,
        });
        this.mostrarConfirmacionGuardado();
    }

    async alternarMejorExamen() {
        const valor = !this.state.mejorExamen;
        this.state.mejorExamen = valor;
        await this.orm.write("taekwondo.examen", [this.props.examenId], {
            mejor_examen: valor,
        });
        this.mostrarConfirmacionGuardado();
        this.props.onMejorExamenCambiado(this.props.examenId, valor);
    }
}
