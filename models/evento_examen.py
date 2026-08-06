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

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get('folio', 'Nuevo') == 'Nuevo':
                vals['folio'] = self.env['ir.sequence'].next_by_code('taekwondo.evento_examen')
        return super().create(vals_list)
