from odoo import api, fields, models


class TaekwondoEventoExamen(models.Model):
    _name = 'taekwondo.evento_examen'
    _description = 'Evento de Examen'

    folio = fields.Char(string='Folio', readonly=True, copy=False, default=lambda self: 'Nuevo')
    fecha_evento = fields.Date(string='Fecha del evento', required=True)
    descripcion = fields.Char(string='Descripción')
    examenes_ids = fields.One2many(
        comodel_name='taekwondo.examen',
        inverse_name='evento_id',
        string='Exámenes',
    )

    @api.depends('fecha_evento')
    def _compute_display_name(self):
        # Sin este override, al no existir un campo 'name' en el modelo,
        # Odoo cae en su texto de emergencia "modelo,id" (ver el mismo
        # diagnóstico ya hecho para taekwondo.dashboard). Aquí el texto se
        # arma solo a partir de fecha_evento - el usuario nunca lo escribe.
        for evento in self:
            if evento.fecha_evento:
                evento.display_name = 'Examen de grado %s' % evento.fecha_evento.strftime('%d/%m/%Y')
            else:
                evento.display_name = 'Nuevo evento de examen'

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get('folio', 'Nuevo') == 'Nuevo':
                vals['folio'] = self.env['ir.sequence'].next_by_code('taekwondo.evento_examen')
        return super().create(vals_list)

    def action_abrir_tablero(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.client',
            'tag': 'mi_primer_modulo.tablero_calificacion',
            'name': 'Tablero de Calificación - %s' % self.folio,
            'params': {
                'evento_id': self.id,
            },
        }
